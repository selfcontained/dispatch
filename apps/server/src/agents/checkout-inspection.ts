import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  open,
  readlink,
  realpath,
  type FileHandle,
} from "node:fs/promises";
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
import {
  collectOwnerReviewChanges,
  ownerReviewPaths,
} from "../shared/git/owner-review-files.js";
import { getPrStatus } from "../shared/github/pr.js";
import type { CommandRunner } from "../shared/lib/run-command.js";

const MAX_QUERY_BYTES = 16 * 1024;
const MAX_REPLY_BYTES = 4 * 1024 * 1024;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_FINGERPRINT_BYTES = 16 * 1024 * 1024;
const MAX_FINGERPRINT_FILES = 10_000;
const MAX_ERROR_BYTES = 4 * 1024;
const execFileAsync = promisify(execFile);

// Git and gh inherit the caller's identity, environment and credentials.
const run: CommandRunner = async (command, args, options = {}) => {
  const { stdout, stderr, exitCode } = await execFileAsync(command, args, {
    cwd: options.cwd,
    env: {
      ...process.env,
      LC_ALL: "C",
      GIT_TERMINAL_PROMPT: "0",
      GH_PROMPT_DISABLED: "1",
    },
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

  const directory = await openLinuxDirectory(path.dirname(target));
  try {
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

// Pin every directory component so a symlink replacement cannot redirect
// traversal. The procfs path acts as openat for Node's pathname APIs.
async function openLinuxDirectory(target: string): Promise<FileHandle> {
  let directory = await open("/", LINUX_OPEN_PATH | constants.O_DIRECTORY);
  try {
    for (const segment of target.split("/").filter(Boolean)) {
      const next = await open(
        `/proc/self/fd/${directory.fd}/${segment}`,
        LINUX_OPEN_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW
      );
      const previous = directory;
      directory = next;
      await previous.close();
    }
    return directory;
  } catch (error) {
    await directory.close();
    throw error;
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

async function recordedReviewBase(root: string): Promise<string | null> {
  const { stdout: ref, exitCode } = await run(
    "git",
    ["symbolic-ref", "--quiet", "HEAD"],
    { cwd: root, allowedExitCodes: [0, 1] }
  );
  if (exitCode !== 0 || !ref.startsWith("refs/heads/")) return null;
  const branch = ref.slice("refs/heads/".length);

  const { stdout: baseBranch } = await run(
    "git",
    ["config", "--local", "--get", `branch.${branch}.dispatchReviewBase`],
    { cwd: root, allowedExitCodes: [0, 1], trimOutput: false }
  );
  const query = { kind: "changes", baseBranch: baseBranch.replace(/\n$/, "") };
  if (!isCheckoutQuery(query)) return null;

  const { exitCode: invalid } = await run(
    "git",
    ["check-ref-format", `refs/heads/${query.baseBranch}`],
    { cwd: root, allowedExitCodes: [0, 1] }
  );
  return invalid === 0 ? query.baseBranch : null;
}

async function describeWorktreePath(root: string, relative: string) {
  const target = path.join(root, relative);
  const parent =
    process.platform === "linux"
      ? await openLinuxDirectory(path.dirname(target))
      : await open(
          path.dirname(target),
          constants.O_DIRECTORY | DARWIN_NOFOLLOW_ANY
        );
  try {
    const entry =
      process.platform === "linux"
        ? `/proc/self/fd/${parent.fd}/${path.basename(target)}`
        : target;
    const stat = await lstat(entry);
    if (stat.isSymbolicLink()) {
      const link = await readlink(entry, { encoding: "buffer" });
      return { mode: stat.mode, link: link.toString("base64"), regular: false };
    }
    if (stat.isDirectory()) {
      throw new Error(
        "Checkout fingerprint cannot inspect a dirty directory or submodule"
      );
    }
    return { mode: stat.mode, regular: stat.isFile() };
  } finally {
    await parent.close();
  }
}

async function fingerprintCheckout(
  root: string,
  base: string,
  head: string,
  staged: string,
  unmerged: string,
  unstaged: string[],
  untracked: string[]
): Promise<string> {
  if (unstaged.length + untracked.length > MAX_FINGERPRINT_FILES)
    throw new Error("Too many dirty files to fingerprint the checkout");

  const hash = createHash("sha256");
  hash.update(JSON.stringify([base, head, staged, unmerged]));
  const buffer = Buffer.alloc(64 * 1024);
  let remaining = MAX_FINGERPRINT_BYTES;
  for (const [kind, files] of [
    ["unstaged", unstaged],
    ["untracked", untracked],
  ] as const) {
    for (const relative of [...new Set(files)].sort()) {
      const descriptor = await describeWorktreePath(root, relative).catch(
        (error) => {
          if (
            kind === "unstaged" &&
            (error as NodeJS.ErrnoException).code === "ENOENT"
          )
            return null;
          throw error;
        }
      );
      hash.update(JSON.stringify([kind, relative, descriptor]));
      if (!descriptor?.regular) continue;
      const file = await openRegularFile(root, relative.split("/"));
      try {
        const before = await file.stat();
        if (!before.isFile())
          throw new Error("Checkout changed while fingerprinting dirty files");
        if (before.size > remaining)
          throw new Error(
            "Dirty file contents exceed the checkout fingerprint limit"
          );
        const content = createHash("sha256");
        let offset = 0;
        for (;;) {
          const { bytesRead } = await file.read(
            buffer,
            0,
            Math.min(buffer.length, remaining + 1),
            offset
          );
          if (bytesRead === 0) break;
          offset += bytesRead;
          remaining -= bytesRead;
          if (remaining < 0)
            throw new Error(
              "Dirty file contents exceed the checkout fingerprint limit"
            );
          content.update(buffer.subarray(0, bytesRead));
        }
        const after = await file.stat();
        if (
          before.mode !== descriptor.mode ||
          before.ctimeMs !== after.ctimeMs ||
          before.size !== offset
        )
          throw new Error("Checkout changed while fingerprinting dirty files");
        hash.update(content.digest());
      } finally {
        await file.close();
      }
    }
  }
  return hash.digest("hex");
}

async function inspectChanges(root: string, baseBranch: string | null) {
  baseBranch ??= await recordedReviewBase(root);
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
  const baseRef = await resolveBaseRef(root, baseBranch, options);
  if (baseRef === null)
    throw new Error("Could not resolve checkout base (origin/main fallback)");
  const [{ stdout: head }, { stdout: base }] = await Promise.all([
    run("git", ["rev-parse", "--verify", "HEAD"], { cwd: root }),
    run(
      "git",
      ["rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`],
      { cwd: root }
    ),
  ]);
  const [changes, staged, unmerged] = await Promise.all([
    collectOwnerReviewChanges(root, base, run, head),
    run(
      "git",
      [
        "diff",
        "--cached",
        "--raw",
        "--no-abbrev",
        "--no-renames",
        "-z",
        head,
        "--",
      ],
      { cwd: root, trimOutput: false }
    ),
    run("git", ["ls-files", "--unmerged", "-z"], {
      cwd: root,
      trimOutput: false,
    }),
  ]);
  const stateId = await fingerprintCheckout(
    root,
    base,
    head,
    staged.stdout,
    unmerged.stdout,
    changes.unstaged,
    changes.untracked
  );
  return {
    kind: "changes" as const,
    baseRef,
    head,
    files: ownerReviewPaths(changes),
    stateId,
  };
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
  const probe = await run("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    trimOutput: false,
    allowedExitCodes: validated.kind === "readFile" ? [0, 128] : [0],
  });
  if (probe.exitCode && !probe.stderr.startsWith("fatal: not a git repository"))
    throw new Error(
      `Could not resolve checkout root: ${probe.stderr.slice(0, MAX_ERROR_BYTES)}`
    );
  const root = probe.exitCode
    ? await realpath(cwd)
    : probe.stdout.replace(/\n$/, "");
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
