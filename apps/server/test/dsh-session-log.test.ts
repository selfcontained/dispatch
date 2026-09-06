import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { constants, zstdCompressSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

import {
  decodeZstdFrames,
  decodeZstdFramesAsync,
  findSessionLog,
  listSessionLogs,
  parseSessionLog,
  readSessionHeader,
  readSessionLog,
  zstdFrameLength,
} from "../src/agents/dsh/session-log.js";

const CHECKSUM = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };

/** One frame per batch, checksummed, the way dsh writes them. */
export function frames(batches: string[]): Buffer {
  return Buffer.concat(batches.map((b) => zstdCompressSync(b, CHECKSUM)));
}

let home = "";
afterEach(async () => {
  if (home) await rm(home, { recursive: true, force: true });
  home = "";
});

describe("decodeZstdFrames", () => {
  it("decodes every concatenated frame, not only the first", () => {
    const text = decodeZstdFrames(
      frames(['{"type":"session","id":"s1"}\n', '{"type":"a"}\n{"type":"b"}\n'])
    );
    expect(text.split("\n").filter(Boolean)).toHaveLength(3);
  });

  it("keeps what a torn final frame already holds", () => {
    const whole = frames([
      '{"type":"session","id":"s1"}\n',
      `{"type":"a","pad":"${"x".repeat(5000)}"}\n{"type":"b"}\n`,
    ]);
    const torn = whole.subarray(0, whole.length - 40);
    const parsed = parseSessionLog(decodeZstdFrames(torn));
    expect(parsed.header?.id).toBe("s1");
    // Whatever survived parses; nothing throws.
    expect(parsed.events.every((e) => typeof e.type === "string")).toBe(true);
  });

  it("skips a corrupt middle frame and keeps the frames after it", async () => {
    const good = frames([
      '{"type":"session","id":"s1"}\n',
      '{"type":"a"}\n',
      '{"type":"b"}\n',
      '{"type":"c"}\n',
    ]);
    // Flip a byte inside the second frame's data, after its header.
    const second = Buffer.from(frames(['{"type":"a"}\n']));
    const corrupt = Buffer.from(good);
    const at = frames(['{"type":"session","id":"s1"}\n']).length + 12;
    corrupt[at] ^= 0x55;
    expect(second.length).toBeGreaterThan(12);
    for (const text of [
      decodeZstdFrames(corrupt),
      await decodeZstdFramesAsync(corrupt),
    ]) {
      const parsed = parseSessionLog(text);
      expect(parsed.header?.id).toBe("s1");
      expect(parsed.events.map((e) => e.type)).toEqual(["b", "c"]);
    }
  });

  it("survives a magic sequence inside compressed data", () => {
    const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]).toString("latin1");
    const body = `{"type":"a","x":"${magic}${"y".repeat(50)}"}\n`;
    const buf = frames(['{"type":"session","id":"s1"}\n', body]);
    const parsed = parseSessionLog(decodeZstdFrames(buf));
    expect(parsed.events.map((e) => e.type)).toEqual(["a"]);
  });
});

describe("zstdFrameLength", () => {
  it("reads each frame's length from its headers, and null for a torn one", () => {
    const a = frames(['{"type":"session","id":"s1"}\n']);
    const b = frames([`{"type":"a","pad":"${"x".repeat(9000)}"}\n`]);
    const both = Buffer.concat([a, b]);
    expect(zstdFrameLength(both, 0)).toBe(a.length);
    expect(zstdFrameLength(both, a.length)).toBe(b.length);
    expect(
      zstdFrameLength(both.subarray(0, both.length - 10), a.length)
    ).toBeNull();
    expect(zstdFrameLength(Buffer.from("not a frame"), 0)).toBeNull();
    // A magic sequence inside a frame's data does not move the boundary.
    const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]).toString("latin1");
    const c = frames([`{"type":"c","x":"${magic}${"y".repeat(40)}"}\n`]);
    expect(zstdFrameLength(c, 0)).toBe(c.length);
    const parsed = parseSessionLog(decodeZstdFrames(Buffer.concat([a, c, b])));
    expect(parsed.events.map((e) => e.type)).toEqual(["c", "a"]);
  });
});

describe("session log files", () => {
  it("finds a session by id across project directories and reads it", async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "dsh-log-"));
    const dir = path.join(
      home,
      "sessions",
      "--proj--",
      "abcdefab-1234-4abc-8abc-abcdefabcdef"
    );
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "session.jsonl.zstd"),
      frames([
        '{"type":"session","version":0,"id":"abcdefab-1234-4abc-8abc-abcdefabcdef","cwd":"/w","parentSession":"p1","origin":"subagent","delegationDepth":1}\n',
        '{"type":"turn/start","seq":1,"time":5,"data":{"turn":1}}\n',
      ])
    );
    const file = await findSessionLog(
      home,
      "abcdefab-1234-4abc-8abc-abcdefabcdef"
    );
    expect(file).toBe(path.join(dir, "session.jsonl.zstd"));
    expect(await findSessionLog(home, "nope")).toBeNull();
    expect(
      await findSessionLog(home, "abcdefab-1234-4abc-8abc-000000000000")
    ).toBeNull();
    const log = await readSessionLog(file!);
    expect(log.header).toEqual({
      id: "abcdefab-1234-4abc-8abc-abcdefabcdef",
      cwd: "/w",
      parentSession: "p1",
      origin: "subagent",
      delegationDepth: 1,
    });
    expect(log.events).toEqual([
      { type: "turn/start", seq: 1, time: 5, data: { turn: 1 } },
    ]);
    expect(await listSessionLogs(home)).toEqual([file]);
    expect(await readSessionHeader(file!)).toMatchObject({
      id: "abcdefab-1234-4abc-8abc-abcdefabcdef",
      parentSession: "p1",
    });
    expect(log.partial).toBe(false);
    expect(await listSessionLogs(path.join(home, "missing"))).toEqual([]);
  });
});
