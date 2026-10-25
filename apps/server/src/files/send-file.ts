import { open, stat } from "node:fs/promises";
import type { FastifyRequest, FastifyReply } from "fastify";

type RangeResult =
  | { kind: "full" }
  | { kind: "unsatisfiable" }
  | { kind: "satisfiable"; start: number; end: number };

// Single-range `Range: bytes=start-end` support — the case video seeking
// and PDF viewers actually issue. Per RFC 9110 §14.2, a Range the server
// doesn't understand — wrong unit, multi-range (comma-separated), or
// unparseable numbers — must be *ignored*, not rejected: the caller falls
// through to a normal 200 with the whole file. Only a syntactically valid
// `bytes=` range that falls outside the file is "unsatisfiable" (416).
function parseRange(rangeHeader: string, fileSize: number): RangeResult {
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) return { kind: "full" };
  const [, startStr, endStr] = match;
  if (startStr === "" && endStr === "") return { kind: "full" };

  let start: number;
  let end: number;
  if (startStr === "") {
    // Suffix range ("last N bytes").
    const suffixLength = Number(endStr);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      return { kind: "full" };
    }
    start = Math.max(0, fileSize - suffixLength);
    end = fileSize - 1;
  } else {
    start = Number(startStr);
    end = endStr === "" ? fileSize - 1 : Number(endStr);
  }

  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < start
  ) {
    return { kind: "full" };
  }
  if (start >= fileSize) {
    return { kind: "unsatisfiable" };
  }

  return { kind: "satisfiable", start, end: Math.min(end, fileSize - 1) };
}

export async function sendStoredFile(
  request: FastifyRequest,
  reply: FastifyReply,
  filePath: string,
  contentType = "application/octet-stream"
) {
  const fileStat = await stat(filePath).catch(() => null);
  if (!fileStat || !fileStat.isFile()) {
    return reply.code(404).send({ error: "File not found." });
  }

  // The type stored with the file, read from its bytes. Bytes with no row
  // are served as opaque data, which the sandbox below also covers.

  reply.header("X-Content-Type-Options", "nosniff");
  // Agent-authored files render in the browser (lightbox iframe or new
  // tab) but must never run same-origin against the Dispatch API. Only
  // passive types are exempt; anything a browser might render as a
  // document (html, xml/xhtml, …) gets an opaque origin.
  const isPassive =
    contentType.startsWith("image/") ||
    contentType === "video/mp4" ||
    contentType === "application/pdf";
  if (!isPassive) {
    reply.header(
      "Content-Security-Policy",
      "sandbox allow-scripts allow-popups"
    );
  }
  // Lets browsers show a video seek bar / issue Range requests at all.
  reply.header("Accept-Ranges", "bytes");

  // Open explicitly rather than createReadStream(filePath) so a file
  // deleted between the stat above and here surfaces as a normal 404
  // instead of a stream error after headers may already be on the wire.
  let handle;
  try {
    handle = await open(filePath, "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return reply.code(404).send({ error: "File not found." });
    }
    throw err;
  }

  // Everything from here until createReadStream succeeds can throw or
  // return early (bad stat, empty file, unsatisfiable range) — `handle`
  // needs closing on every one of those paths. Once the stream exists,
  // its `autoClose` plus Fastify's own stream teardown own the fd, so the
  // finally below backs off as soon as `streamStarted` flips.
  let streamStarted = false;
  try {
    // Re-stat the open handle rather than trusting the `stat` above —
    // closes the window where the file is replaced, or turned into a
    // directory, between that call and here (open() on a directory
    // succeeds on macOS/Linux; the read would fail EISDIR mid-response),
    // and it means Content-Length/Content-Range describe the same bytes
    // the fd will actually read.
    const stats = await handle.stat();
    if (!stats.isFile()) {
      return reply.code(404).send({ error: "File not found." });
    }
    const { size } = stats;

    if (size === 0) {
      // createReadStream({ end: -1 }) throws for an empty file, and
      // there's nothing to stream either way.
      reply.header("Content-Length", 0);
      return reply.code(200).type(contentType).send("");
    }

    let start = 0;
    let end = size - 1;
    let status: 200 | 206 = 200;
    const rangeHeader = request.headers.range;
    if (typeof rangeHeader === "string" && rangeHeader.length > 0) {
      const range = parseRange(rangeHeader, size);
      if (range.kind === "unsatisfiable") {
        reply.header("Content-Range", `bytes */${size}`);
        return reply.code(416).send();
      }
      if (range.kind === "satisfiable") {
        ({ start, end } = range);
        status = 206;
      }
      // "full" (unrecognized unit, multi-range, or unparseable numbers)
      // falls through to the whole-file response below.
    }

    const stream = handle.createReadStream({ start, end, autoClose: true });
    streamStarted = true;
    // A client that aborts mid-stream (closed tab, re-seek before the
    // previous range finished) would otherwise leave the fd open.
    reply.raw.on("close", () => {
      if (!stream.destroyed) stream.destroy();
    });
    stream.on("error", (err) => {
      request.log.error({ err, filePath }, "File stream read error");
    });

    reply.code(status);
    if (status === 206) {
      reply.header("Content-Range", `bytes ${start}-${end}/${size}`);
    }
    reply.header("Content-Length", end - start + 1);
    return reply.type(contentType).send(stream);
  } finally {
    if (!streamStarted) {
      await handle.close().catch(() => {});
    }
  }
}
