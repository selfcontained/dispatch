import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { posix, basename, isAbsolute } from "node:path";
import {
  RunnerCallError,
  pathFromWire,
  sessionToWire,
  type Runner,
  type Req,
  type Res,
  type CallName,
  type CallOptions,
} from "@dispatch/runner-protocol/contract";

/** The bytes of a session file, as a runner transport sends them. */
export type SessionFileSource = {
  size: number;
  /** A fresh read of the bytes, for a stream. */
  open(): Readable;
  /** The whole file, for a v1 frame. */
  read(): Promise<Buffer>;
};

/**
 * A file on this machine that `files.put` hands to a session. The request's
 * `blob` names it and the transport resolves it (design 1.3): the local
 * runner hands over the path where it is, with no read; a remote runner
 * streams the bytes. Size and digest are taken here, lazily, by the
 * transport that needs them.
 */
export type SessionFileBlob = {
  /** Where the file is on this machine. */
  path: string;
  /**
   * `prompt`: a missing file fails the put (it drops out of the prompt).
   * `reference`: a listed row, handed over as it is; a runner stores it
   * under its digest so a changed file gets a new path.
   */
  purpose: "prompt" | "reference";
  digest(): Promise<string>;
  source(digest?: string): Promise<SessionFileSource>;
};

const PREFIX = "dispatch-session-file:";
const blobs = new Map<string, SessionFileBlob>();

/** Name `file` as a `files.put` blob for the duration of `run`. */
export async function withSessionFileBlob<T>(
  file: SessionFileBlob,
  run: (blob: string) => Promise<T>
): Promise<T> {
  const blob = PREFIX + randomUUID();
  blobs.set(blob, file);
  try {
    return await run(blob);
  } finally {
    blobs.delete(blob);
  }
}

/** The file a `files.put` request's `blob` names. */
export function sessionFileBlob(blob: string): SessionFileBlob {
  const file = blobs.get(blob);
  if (!file)
    throw new RunnerCallError({
      code: "invalid",
      message: "Unknown session file.",
    });
  return file;
}

const BYTES_PREFIX = "dispatch-session-file-bytes:";
const read = new Map<string, Buffer>();

/**
 * A `files.get` answer's `blob` for bytes read in this process: the caller
 * takes the same `Buffer` back, with no encoding (design 1.3).
 */
export function sessionFileBytesBlob(bytes: Buffer): string {
  const blob = BYTES_PREFIX + randomUUID();
  read.set(blob, bytes);
  return blob;
}

/** The bytes a `files.get` answer's `blob` names, once; else undefined. */
export function takeSessionFileBytes(blob: string): Buffer | undefined {
  const bytes = read.get(blob);
  read.delete(blob);
  return bytes;
}

/** Transport-owned I/O; callers and reference deduplication are shared. */
export type SessionFileTransfer = {
  copyReferences: boolean;
  scope: object;
  namespace: string;
  upload(
    input: Req<"files.put">,
    file: SessionFileBlob,
    digest?: string
  ): Promise<Res<"files.put">>;
  download(
    input: Req<"files.get">,
    signal?: AbortSignal
  ): Promise<{ bytes: Buffer; name: string; digest: string }>;
};
const references = new WeakMap<
  object,
  Map<string, Promise<Res<"files.put">>>
>();

/** File operations always enter through this adapter, whichever transport owns the session. */
export function withSessionFiles(
  runner: Runner,
  session: string | undefined,
  transfer: SessionFileTransfer
): Runner {
  return {
    ...runner,
    describe: runner.describe.bind(runner),
    open: runner.open.bind(runner),
    async call<K extends CallName>(
      op: K,
      input: Req<K>,
      options?: CallOptions<K>
    ): Promise<Res<K>> {
      if (op !== "files.get" && op !== "files.put")
        return runner.call(op, input, options);
      const request = input as Req<"files.get"> | Req<"files.put">;
      if (sessionToWire(request.session) !== session)
        throw new RunnerCallError({
          code: "invalid",
          message: "Invalid session file binding.",
        });
      if (op === "files.get") {
        const { bytes, name, digest } = await transfer.download(
          input as Req<"files.get">,
          options?.signal
        );
        return {
          name,
          size: bytes.length,
          digest,
          blob: sessionFileBytesBlob(bytes),
        } as Res<K>;
      }
      const put = input as Req<"files.put">;
      const file = sessionFileBlob(put.blob);
      if (!transfer.copyReferences || file.purpose === "prompt")
        return transfer.upload(put, file) as Promise<Res<K>>;
      const digest = await file.digest();
      const name = `reference-${digest}${posix.extname(put.name).slice(0, 32)}`;
      let delivered = references.get(transfer.scope);
      if (!delivered) references.set(transfer.scope, (delivered = new Map()));
      const key = JSON.stringify([transfer.namespace, session, name]);
      let delivery = delivered.get(key);
      if (!delivery) {
        const cache = delivered;
        delivery = transfer
          .upload({ ...put, name }, file, digest)
          .catch((error) => {
            cache.delete(key);
            throw error;
          });
        delivered.set(key, delivery);
      }
      return delivery as Promise<Res<K>>;
    },
  };
}

type LocalFilePeer = Pick<Runner, "call"> & {
  sendBlob?(
    id: string,
    source: { path: string; inPlace: { mustExist: boolean } }
  ): Promise<void>;
  getFile?(input: Req<"files.get">, signal?: AbortSignal): Promise<Buffer>;
};
/** Local transport compatibility belongs here, including its in-place and recovery I/O. */
export function localSessionFiles(options: {
  peer?: LocalFilePeer;
  bound(
    session: Req<"files.get">["session"],
    signal?: AbortSignal
  ): Promise<boolean>;
  fallback: {
    put(source: string, purpose: SessionFileBlob["purpose"]): Promise<string>;
    get(source: string): Promise<Buffer>;
  };
  mayWrite(): void;
}): SessionFileTransfer {
  const { peer, fallback } = options;
  return {
    copyReferences: false,
    scope: peer ?? fallback,
    namespace: "local",
    async upload(input, file) {
      if (peer?.sendBlob && (await options.bound(input.session))) {
        const blob = `file:${randomUUID()}`;
        const [answer] = await Promise.allSettled([
          peer.call("files.put", { ...input, blob }, { wait: false } as never),
          peer.sendBlob(blob, {
            path: file.path,
            inPlace: { mustExist: file.purpose === "prompt" },
          }),
        ]);
        if (answer.status === "fulfilled") return answer.value;
        if (
          !(
            answer.reason instanceof RunnerCallError &&
            answer.reason.code === "unavailable"
          )
        )
          throw answer.reason;
      }
      options.mayWrite();
      return {
        path: pathFromWire(await fallback.put(file.path, file.purpose)),
      };
    },
    async download(input, signal) {
      let bytes: Buffer | undefined;
      if (
        input.path &&
        peer?.getFile &&
        (await options.bound(input.session, signal))
      ) {
        try {
          bytes = await peer.getFile(
            {
              ...input,
              path: isAbsolute(input.path)
                ? input.path
                : `${process.cwd()}/${input.path}`,
            },
            signal
          );
        } catch (error) {
          if (signal?.aborted) throw error;
          const details = error instanceof RunnerCallError && error.details;
          if (
            details &&
            typeof details === "object" &&
            !Array.isArray(details) &&
            typeof details.errno === "string"
          )
            throw Object.assign(
              new Error(
                typeof details.path === "string"
                  ? error.message.replace(
                      `'${details.path}'`,
                      `'${input.path}'`
                    )
                  : error.message
              ),
              {
                code: details.errno,
                ...(typeof details.nativeErrno === "number" && {
                  errno: details.nativeErrno,
                }),
                ...(typeof details.syscall === "string" && {
                  syscall: details.syscall,
                }),
                ...(typeof details.path === "string" && { path: input.path }),
              }
            );
          // Reads can be repeated locally after loss, an old inline-only peer,
          // or an unavailable binding. This preserves Local's recovery behavior.
        }
      }
      bytes ??= await fallback.get(input.path);
      return { bytes, name: basename(input.path), digest: "" };
    },
  };
}
