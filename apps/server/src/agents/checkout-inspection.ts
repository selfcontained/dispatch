import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  isCheckoutQuery,
  type CheckoutQuery,
  type CheckoutReply,
} from "@dispatch/runner-protocol";

import {
  refreshRemoteBaseRef,
  resolveBaseRef,
} from "../shared/git/base-ref.js";
import { collectOwnerReviewFiles } from "../shared/git/owner-review-files.js";
import { getPrStatus } from "../shared/github/pr.js";
import type { CommandRunner } from "../shared/lib/run-command.js";

const MAX_QUERY_BYTES = 16 * 1024;
const MAX_REPLY_BYTES = 4 * 1024 * 1024;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_ERROR_BYTES = 4 * 1024;
const execFileAsync = promisify(execFile);

// Git and gh inherit the caller's identity, environment and credentials.
const run: CommandRunner = async (command, args, options = {}) => {
  const { stdout, stderr, exitCode } = await execFileAsync(command, args, {
    cwd: options.cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" },
    maxBuffer: MAX_REPLY_BYTES,
    timeout: options.timeoutMs ?? 5_000,
    killSignal: "SIGKILL",
  })
    .then((result) => ({ ...result, exitCode: 0 }))
    .catch((error) => {
      if (
        typeof error.code === "number" &&
        options.allowedExitCodes?.includes(error.code)
      ) {
        return {
          stdout: error.stdout as string,
          stderr: error.stderr as string,
          exitCode: error.code as number,
        };
      }
      const detail =
        error.stderr?.trim().slice(0, MAX_ERROR_BYTES) ||
        error.code ||
        error.signal;
      throw new Error(
        `Checkout inspection ${command} failed: ${detail ?? "unknown error"}`
      );
    });

  return {
    stdout: options.trimOutput === false ? stdout : stdout.trim(),
    stderr: stderr.trim(),
    exitCode,
  };
};

function parseQuery(input: unknown): CheckoutQuery {
  if (isCheckoutQuery(input) && Object.keys(input).length === 2) return input;
  throw new Error("Invalid checkout inspection query");
}

function validateFilePath(file: string): string[] {
  const segments = file.split("/");
  if (
    file.includes("\0") ||
    file.includes("\\") ||
    /^[a-z]:/i.test(file) ||
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        segment.toLowerCase() === ".git"
    )
  ) {
    throw new Error("Expected a repository-relative worktree file path");
  }
  return segments;
}

// These flags are provided by the operating systems but aren't exposed by Node.
const DARWIN_NOFOLLOW_ANY = 0x20000000;
const LINUX_OPEN_PATH = 0x200000;

async function openRegularFile(
  root: string,
  segments: string[]
): Promise<FileHandle> {
  const target = path.join(root, ...segments);
  if (process.platform === "darwin") {
    if (!(await lstat(target)).isFile())
      throw new Error("Expected a regular worktree file");
    return open(
      target,
      constants.O_RDONLY | constants.O_NONBLOCK | DARWIN_NOFOLLOW_ANY
    );
  }
  if (process.platform !== "linux") {
    throw new Error("Checkout file inspection requires macOS or Linux");
  }

  // Open each component relative to a pinned directory. A concurrent symlink
  // replacement can't redirect either the directory traversal or the file open.
  let directory = await open("/", LINUX_OPEN_PATH | constants.O_DIRECTORY);
  try {
    for (const segment of path
      .join(root, ...segments.slice(0, -1))
      .split("/")
      .filter(Boolean)) {
      const next = await open(
        `/proc/self/fd/${directory.fd}/${segment}`,
        LINUX_OPEN_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW
      );
      await directory.close();
      directory = next;
    }
    const entry = await open(
      `/proc/self/fd/${directory.fd}/${segments.at(-1)}`,
      LINUX_OPEN_PATH | constants.O_NOFOLLOW
    );
    try {
      if (!(await entry.stat()).isFile())
        throw new Error("Expected a regular worktree file");
      return await open(`/proc/self/fd/${entry.fd}`, constants.O_RDONLY);
    } finally {
      await entry.close();
    }
  } finally {
    await directory.close();
  }
}

async function readWorktreeFile(
  root: string,
  segments: string[]
): Promise<string | null> {
  try {
    const file = await openRegularFile(root, segments);
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new Error("Expected a regular worktree file");
      if (stat.size > MAX_FILE_BYTES)
        throw new Error("Checkout file is too large");
      // Enforce the limit even if the file grows after stat.
      const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
      let size = 0;
      while (size < bytes.length) {
        const { bytesRead } = await file.read(
          bytes,
          size,
          bytes.length - size,
          size
        );
        if (bytesRead === 0) return bytes.toString("utf8", 0, size);
        size += bytesRead;
      }
      throw new Error("Checkout file is too large");
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function inspectChanges(
  root: string,
  baseBranch: string | null
): Promise<CheckoutReply> {
  if (baseBranch === null) {
    try {
      baseBranch = (await getPrStatus({ cwd: root }, run)).baseRefName;
    } catch {
      // No usable PR; the base helpers fall back to the upstream or main.
    }
  }
  const options = {
    runCommand: run,
    allowUpstreamFallback: baseBranch === null,
  };
  await refreshRemoteBaseRef(root, baseBranch, options);
  const baseRef =
    (await resolveBaseRef(root, baseBranch, options)) ?? "origin/main";
  const { stdout: head } = await run("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: root,
  });
  const files = await collectOwnerReviewFiles(root, baseRef, run, head);
  return { kind: "changes", baseRef, head, files };
}

function encodeReply(reply: CheckoutReply): string {
  const encoded = JSON.stringify(reply) + "\n";
  if (Buffer.byteLength(encoded) > MAX_REPLY_BYTES) {
    throw new Error("Checkout inspection reply is too large");
  }
  return encoded;
}

export async function inspectCheckout(
  cwd: string,
  query: CheckoutQuery
): Promise<CheckoutReply> {
  const validated = parseQuery(query);
  // Preserve whitespace in the root, removing only Git's terminating newline.
  const { stdout } = await run("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    trimOutput: false,
  });
  const root = stdout.replace(/\n$/, "");
  if (!path.isAbsolute(root))
    throw new Error("Could not resolve checkout root");
  const reply: CheckoutReply =
    validated.kind === "changes"
      ? await inspectChanges(root, validated.baseBranch)
      : {
          kind: "readFile",
          content: await readWorktreeFile(
            root,
            validateFilePath(validated.path)
          ),
        };
  encodeReply(reply);
  return reply;
}

export async function runCheckoutInspectionCli(cwd: string): Promise<void> {
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_QUERY_BYTES)
        throw new Error("Checkout inspection query is too large");
      chunks.push(bytes);
    }
    const query = parseQuery(
      JSON.parse(Buffer.concat(chunks).toString("utf8"))
    );
    const reply = await inspectCheckout(cwd, query);
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(encodeReply(reply), (error) =>
        error ? reject(error) : resolve()
      );
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Checkout inspection failed";
    process.stderr.write(message.slice(0, MAX_ERROR_BYTES) + "\n");
    process.exitCode = 1;
  }
}
