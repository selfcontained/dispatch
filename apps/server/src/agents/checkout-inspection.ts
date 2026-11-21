import { DefaultBranchFiles } from "./default-branch-files.js";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  DARWIN_NOFOLLOW_ANY,
  openRegularFile,
  openLinuxDirectory,
} from "../files/open-workspace-file.js";
import { openWorkspaceDirectory } from "../files/workspace-directory.js";
import { resolveRepoRoot } from "../shared/git/git-context.js";
import { constants } from "node:fs";
import { lstat, open, readdir, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  isCheckoutQuery,
  type CheckoutQuery,
  type CheckoutReply,
  type CheckoutState,
  validBranch,
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
      ...options.env,
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

export const defaultBranchFiles = new DefaultBranchFiles(run);

function parseQuery(input: unknown): CheckoutQuery {
  if (
    isCheckoutQuery(input) &&
    Object.keys(input).length ===
      (input.kind === "roots" ? 1 : input.kind === "defaultBranchFiles" ? 3 : 2)
  )
    return input;
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

export async function recordedReviewBase(root: string): Promise<string | null> {
  const { stdout: ref, exitCode } = await run(
    "git",
    ["symbolic-ref", "--quiet", "HEAD"],
    { cwd: root, allowedExitCodes: [0, 1, 128] }
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

async function inspectChanges(
  root: string,
  baseBranch: string | null,
  recordedBase: boolean,
  unresolvedBase?: string
) {
  if (recordedBase) baseBranch ??= await recordedReviewBase(root);
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
    (await resolveBaseRef(root, baseBranch, options)) ?? unresolvedBase;
  if (!baseRef)
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

export async function observeScratchCheckout(
  dir: string
): Promise<CheckoutState> {
  const root = await realpath(dir);
  const identity = await lstat(root);
  const directories: string[] = [];
  const files: string[] = [];
  let entriesSeen = 0;
  async function collect(relative: string): Promise<void> {
    for (const entry of await readdir(path.join(root, relative), {
      withFileTypes: true,
    })) {
      if (++entriesSeen > MAX_FINGERPRINT_FILES)
        throw new Error("Too many scratch checkout entries to fingerprint");
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        directories.push(name);
        await collect(name);
      } else {
        if (!entry.isFile() && !entry.isSymbolicLink())
          throw new Error("Unsupported scratch checkout entry");
        files.push(name);
      }
    }
  }
  await collect("");
  const stateId = await fingerprintCheckout(
    root,
    JSON.stringify([root, identity.dev, identity.ino, directories.sort()]),
    "",
    "",
    "",
    [],
    files
  );
  return {
    path: root,
    branch: null,
    stateId,
    unmerged: false,
    changedFiles: [],
    uncommittedFiles: [...directories, ...files].sort(),
  };
}

/** Strict observation for deletion. Any Git or fingerprint failure is unknown. */
export async function observeGitCheckout(
  dir: string,
  baseBranch: string | null = null
): Promise<CheckoutState> {
  if (baseBranch !== null && !validBranch(baseBranch))
    throw new Error("Invalid checkout base branch");
  const root = await realpath(dir);
  const cwd = { cwd: root, trimOutput: false };
  const top = await run("git", ["rev-parse", "--show-toplevel"], cwd);
  if (top.stdout.replace(/\n$/, "") !== root)
    throw new Error("The bound directory is not a Git checkout root");
  const identity = await lstat(root);
  baseBranch ??= await recordedReviewBase(root);
  const options = {
    runCommand: run,
    allowUpstreamFallback: baseBranch === null,
  };
  await refreshRemoteBaseRef(root, baseBranch, options);
  const baseRef = await resolveBaseRef(root, baseBranch, options);
  if (
    !baseRef ||
    (baseBranch && baseRef !== baseBranch && baseRef !== `origin/${baseBranch}`)
  )
    throw new Error("Could not resolve the checkout base");
  const [{ stdout: head }, { stdout: base }, branch] = await Promise.all([
    run("git", ["rev-parse", "--verify", "HEAD"], { cwd: root }),
    run("git", ["rev-parse", "--verify", `${baseRef}^{commit}`], { cwd: root }),
    run("git", ["symbolic-ref", "--short", "--quiet", "HEAD"], {
      cwd: root,
      allowedExitCodes: [0, 1],
    }),
  ]);
  const [changes, staged, conflicts, merge, baseTree] = await Promise.all([
    collectOwnerReviewChanges(root, base, run, head),
    run(
      "git",
      ["diff", "--cached", "--raw", "--no-abbrev", "-z", head, "--"],
      cwd
    ),
    run("git", ["ls-files", "--unmerged", "-z"], cwd),
    run("git", ["merge-tree", "--write-tree", base, head], {
      cwd: root,
      allowedExitCodes: [0, 1],
    }),
    run("git", ["rev-parse", "--verify", `${base}^{tree}`], { cwd: root }),
  ]);
  const unpublishedHistory =
    changes.committed.length === 0 &&
    (
      await run("git", ["merge-base", "--is-ancestor", head, base], {
        cwd: root,
        allowedExitCodes: [0, 1],
      })
    ).exitCode === 1;
  const unmerged =
    unpublishedHistory ||
    merge.exitCode !== 0 ||
    merge.stdout.split("\n")[0] !== baseTree.stdout;
  const state = await fingerprintCheckout(
    root,
    base,
    head,
    staged.stdout,
    conflicts.stdout,
    changes.unstaged,
    changes.untracked
  );
  const stateId = createHash("sha256")
    .update(
      JSON.stringify([root, identity.dev, identity.ino, branch.stdout, state])
    )
    .digest("hex");
  return {
    path: root,
    branch: branch.exitCode === 0 ? branch.stdout : null,
    stateId,
    unmerged,
    changedFiles: unmerged ? changes.committed : [],
    uncommittedFiles: [
      ...new Set([
        ...changes.staged,
        ...changes.unstaged,
        ...changes.untracked,
      ]),
    ].sort(),
  };
}

function encodeReply(reply: CheckoutReply): string {
  const encoded = JSON.stringify(reply) + "\n";
  if (Buffer.byteLength(encoded) > MAX_REPLY_BYTES) {
    throw new Error("Checkout inspection reply is too large");
  }
  return encoded;
}

async function inspectionRoot(cwd: string, requireGit: boolean) {
  // Preserve whitespace in the root, removing only Git's terminating newline.
  const probe = await run("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    trimOutput: false,
    allowedExitCodes: requireGit ? [0] : [0, 128],
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
  return { root, hasGit: probe.exitCode === 0 };
}

export async function readCheckoutCommandFile(
  cwd: string,
  file: string,
  {
    configuredRoot,
    exact = false,
  }: { configuredRoot?: string; exact?: boolean } = {}
) {
  const root = exact
    ? await realpath(cwd)
    : (await inspectionRoot(cwd, false)).root;
  if (configuredRoot) {
    const relative = path.relative(configuredRoot, root);
    if (
      relative === ".." ||
      relative.startsWith(".." + path.sep) ||
      path.isAbsolute(relative)
    )
      throw new Error(
        "Repository root is outside the configured runner checkout."
      );
  }
  const content = await readWorktreeFile(root, validateFilePath(file));
  return { root, content };
}

export type InspectCheckoutOptions = {
  /**
   * Consult the base a runner recorded in Git config when the service sent
   * none. Runner checkouts keep it for older services and rows; the native
   * executor always receives the service's base and skips it.
   */
  recordedBase?: boolean;
  /** Native owner reviews attempt this ref if the usual Git probes fail. */
  unresolvedBase?: string;
};

export async function inspectCheckout(
  cwd: string,
  query: CheckoutQuery,
  { recordedBase = true, unresolvedBase }: InspectCheckoutOptions = {}
): Promise<CheckoutReply> {
  const validated = parseQuery(query);
  if (validated.kind === "defaultBranchFiles") {
    const reply = await defaultBranchFiles.get(
      cwd,
      validated.directories,
      validated.waitForRefresh
    );
    encodeReply(reply);
    return reply;
  }
  const { root, hasGit } = await inspectionRoot(
    cwd,
    validated.kind === "changes"
  );
  if (validated.kind === "roots")
    return {
      kind: "roots",
      checkoutRoot: root,
      repositoryRoot: hasGit ? await resolveRepoRoot(root) : null,
    };
  if (validated.kind === "listFiles") {
    const canonicalRoot = await realpath(root);
    const directoryPath = path.join(
      canonicalRoot,
      ...validateFilePath(validated.path)
    );
    try {
      const { directory, verify } = await openWorkspaceDirectory(
        canonicalRoot,
        directoryPath
      );
      const names: string[] = [];
      let scanned = 0;
      for await (const entry of directory) {
        if (++scanned > 1024)
          throw new Error("Checkout directory contains too many entries");
        if (
          entry.isFile() &&
          !entry.name.includes("\\") &&
          entry.name.toLowerCase() !== ".git"
        )
          names.push(entry.name);
      }
      await verify();
      const reply = { kind: "listFiles" as const, names: names.sort() };
      encodeReply(reply);
      return reply;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { kind: "listFiles", names: [] };
      throw error;
    }
  }
  const reply: CheckoutReply =
    validated.kind === "changes"
      ? await inspectChanges(
          root,
          validated.baseBranch,
          recordedBase,
          unresolvedBase
        )
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
    const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const query = parseQuery(input);
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
