import {
  DefaultBranchFiles,
  type DefinitionParser,
  CATALOG_LIMIT_WARNING,
} from "./default-branch-files.js";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  DARWIN_NOFOLLOW_ANY,
  openLinuxDirectory,
} from "../files/open-workspace-file.js";
import {
  resolveRepoRoot,
  resolveWorktreeRoot,
} from "../shared/git/git-context.js";
import { constants } from "node:fs";
import {
  lstat,
  open,
  opendir,
  readdir,
  readlink,
  realpath,
  stat as statPath,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  isCheckoutQuery,
  UNOBSERVED_STATE,
  type CheckoutQuery,
  type CheckoutReply,
  type CheckoutState,
} from "@dispatch/runner-protocol";

import {
  refreshRemoteBaseRef,
  resolveBaseRef,
} from "../shared/git/base-ref.js";
import {
  collectCheckoutChanges,
  checkoutChangedPaths,
} from "../shared/git/checkout-change-files.js";
import { getPrStatus } from "../shared/github/pr.js";
import type { CommandRunner } from "../shared/lib/run-command.js";
import { childProcessEnv } from "../shared/process/child-environment.js";

const MAX_QUERY_BYTES = 16 * 1024;
const MAX_REPLY_BYTES = 4 * 1024 * 1024;
const MAX_SCRATCH_ENTRIES = 10_000;
const MAX_ERROR_BYTES = 4 * 1024;
const execFileAsync = promisify(execFile);

// Git and gh inherit the caller's identity, environment and credentials.
const run: CommandRunner = async (command, args, options = {}) => {
  const { stdout, stderr, exitCode } = await execFileAsync(command, args, {
    cwd: options.cwd,
    env: {
      ...childProcessEnv(),
      LC_ALL: "C",
      GIT_TERMINAL_PROMPT: "0",
      GH_PROMPT_DISABLED: "1",
      ...options.env,
    },
    maxBuffer: Infinity,
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
    // Configuration files may be symlinks, as they were before the runner
    // protocol: follow them like a plain read of the path would.
    const file = await open(
      path.join(root, ...segments),
      constants.O_RDONLY | constants.O_NONBLOCK
    );
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new Error("Expected a regular worktree file");
      return await file.readFile("utf8");
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function readRecordedBase(root: string): Promise<string | null> {
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
      return { mode: stat.mode, link: link.toString("base64") };
    }
    const { mode, ino, size, mtimeMs, ctimeMs } = stat;
    return { mode, ino, size, mtimeMs, ctimeMs };
  } finally {
    await parent.close();
  }
}

/** Identity by metadata: no content is read, so nothing is too big to identify. */
async function fingerprintCheckout(
  root: string,
  base: string,
  head: string,
  staged: string,
  unmerged: string,
  unstaged: string[],
  untracked: string[]
): Promise<string> {
  const hash = createHash("sha256");
  hash.update(JSON.stringify([base, head, staged, unmerged]));
  for (const [kind, files] of [
    ["unstaged", unstaged],
    ["untracked", untracked],
  ] as const) {
    for (const relative of [...new Set(files)].sort()) {
      const descriptor = await describeWorktreePath(root, relative).catch(
        // An entry that is gone or unreadable still has an identity.
        (error: NodeJS.ErrnoException) => ({ error: error.code ?? "unknown" })
      );
      hash.update(JSON.stringify([kind, relative, descriptor]));
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
  if (recordedBase) baseBranch ??= await readRecordedBase(root);
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
    collectCheckoutChanges(root, base, run, head),
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
    files: checkoutChangedPaths(changes),
    stateId,
  };
}

export async function observeScratchCheckout(
  dir: string,
  fingerprint = true
): Promise<CheckoutState> {
  const root = await realpath(dir);
  const identity = fingerprint ? await lstat(root) : null;
  const directories: string[] = [];
  const files: string[] = [];
  let entriesSeen = 0;
  async function collect(relative: string): Promise<void> {
    for (const entry of await readdir(path.join(root, relative), {
      withFileTypes: true,
    })) {
      if (++entriesSeen > MAX_SCRATCH_ENTRIES)
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
  const stateId = identity
    ? await fingerprintCheckout(
        root,
        JSON.stringify([root, identity.dev, identity.ino, directories.sort()]),
        "",
        "",
        "",
        [],
        files
      )
    : UNOBSERVED_STATE;
  return {
    path: root,
    branch: null,
    stateId,
    unmerged: false,
    changedFiles: [],
    uncommittedFiles: [...directories, ...files].sort(),
  };
}

// Match the archive comparison against the checked-out branch's upstream.
async function readArchiveChanges(root: string) {
  let upstream: string | null = null;
  const tracking = await run(
    "git",
    ["rev-parse", "--abbrev-ref", "@{upstream}"],
    {
      cwd: root,
      allowedExitCodes: [0, 128],
      timeoutMs: 5_000,
    }
  ).catch(() => null);
  if (tracking?.exitCode === 0 && tracking.stdout) upstream = tracking.stdout;
  const remoteBranch = upstream?.startsWith("origin/")
    ? upstream.slice("origin/".length)
    : "main";
  await run("git", ["fetch", "origin", remoteBranch, "--quiet"], {
    cwd: root,
    allowedExitCodes: [0, 1, 128],
    timeoutMs: 15_000,
  });
  const baseRef = await resolveBaseRef(root, upstream, { runCommand: run });
  if (!baseRef) return { baseRef, changedFiles: [] };
  const merge = await run(
    "git",
    ["merge-tree", "--write-tree", baseRef, "HEAD"],
    {
      cwd: root,
      allowedExitCodes: [0, 1],
      timeoutMs: 10_000,
    }
  );
  const tree = await run("git", ["rev-parse", `${baseRef}^{tree}`], {
    cwd: root,
  });
  const mergedTree = merge.stdout.split("\n")[0];
  if (tree.stdout === mergedTree) return { baseRef, changedFiles: [] };
  const diff = await run(
    "git",
    ["diff", "--name-only", tree.stdout, mergedTree],
    {
      cwd: root,
      timeoutMs: 10_000,
    }
  );
  return { baseRef, changedFiles: diff.stdout.split("\n").filter(Boolean) };
}

export async function observeGitCheckout(
  dir: string,
  fingerprint = true
): Promise<CheckoutState> {
  const root = await realpath(dir);
  const cwd = { cwd: root, trimOutput: false };
  const [branch, status, { baseRef, changedFiles }] = await Promise.all([
    run("git", ["symbolic-ref", "--short", "--quiet", "HEAD"], {
      cwd: root,
      allowedExitCodes: [0, 1],
    }).catch(() => null),
    run("git", ["status", "--porcelain"], {
      cwd: root,
      timeoutMs: 10_000,
    }).catch(() => null),
    readArchiveChanges(root).catch(() => ({ baseRef: null, changedFiles: [] })),
  ]);

  // The archive checks are independent. An unreadable index, for example,
  // prevents a fingerprint but still leaves the committed comparison usable.
  const stateId = fingerprint
    ? await (async () => {
        const top = await run("git", ["rev-parse", "--show-toplevel"], cwd);
        if (top.stdout.replace(/\n$/, "") !== root)
          throw new Error("The bound directory is not a Git checkout root");
        const identity = await lstat(root);
        const { stdout: head } = await run(
          "git",
          ["rev-parse", "--verify", "HEAD"],
          { cwd: root }
        );
        const { stdout: base } = baseRef
          ? await run("git", ["rev-parse", "--verify", `${baseRef}^{commit}`], {
              cwd: root,
            })
          : { stdout: head };
        const [changes, staged, conflicts] = await Promise.all([
          collectCheckoutChanges(root, base, run, head),
          run(
            "git",
            ["diff", "--cached", "--raw", "--no-abbrev", "-z", head, "--"],
            cwd
          ),
          run("git", ["ls-files", "--unmerged", "-z"], cwd),
        ]);
        const state = await fingerprintCheckout(
          root,
          base,
          head,
          staged.stdout,
          conflicts.stdout,
          changes.unstaged,
          changes.untracked
        );
        return createHash("sha256")
          .update(
            JSON.stringify([
              root,
              identity.dev,
              identity.ino,
              branch?.stdout,
              state,
            ])
          )
          .digest("hex");
      })().catch(() => UNOBSERVED_STATE)
    : UNOBSERVED_STATE;
  return {
    path: root,
    branch: branch?.exitCode === 0 ? branch.stdout : null,
    stateId,
    unmerged: changedFiles.length > 0,
    changedFiles,
    uncommittedFiles: status?.stdout.split("\n").filter(Boolean) ?? [],
  };
}

function encodeReply(reply: CheckoutReply): string {
  if (reply.kind === "defaultBranchFiles") {
    const files = reply.files.filter(
      ({ path, content }) =>
        path.length <= 4096 &&
        !path.includes("\\") &&
        Buffer.byteLength(content) <= 256 * 1024
    );
    reply = { ...reply, files };
    const encoded = JSON.stringify(reply) + "\n";
    if (Buffer.byteLength(encoded) <= MAX_REPLY_BYTES) return encoded;

    const limited = {
      ...reply,
      files: [] as typeof reply.files,
      truncated: true,
      warnings: reply.warnings.includes(CATALOG_LIMIT_WARNING)
        ? reply.warnings
        : [...reply.warnings, CATALOG_LIMIT_WARNING],
    };
    let bytes = Buffer.byteLength(JSON.stringify(limited) + "\n");
    for (const file of reply.files) {
      bytes +=
        Buffer.byteLength(JSON.stringify(file)) +
        Number(limited.files.length > 0);
      if (bytes > MAX_REPLY_BYTES) break;
      limited.files.push(file);
    }
    reply = limited;
  }
  const encoded = JSON.stringify(reply) + "\n";
  if (Buffer.byteLength(encoded) > MAX_REPLY_BYTES) {
    throw new Error("Checkout inspection reply is too large");
  }
  return encoded;
}

/** The root a checkout read's relative paths resolve against. */
export async function inspectionRoot(cwd: string, requireGit: boolean) {
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
  return { root };
}

export async function resolveInspectionRoots(cwd: string) {
  const repositoryRoot = await resolveRepoRoot(cwd, {
    commandRunner: run,
  }).catch(() => null);
  const checkoutRoot = repositoryRoot
    ? await resolveWorktreeRoot(cwd, { commandRunner: run }).catch(() => null)
    : null;
  return { checkoutRoot, repositoryRoot };
}

async function effectiveCommandRoot(cwd: string) {
  const { checkoutRoot, repositoryRoot } = await resolveInspectionRoots(cwd);
  return (
    checkoutRoot ?? repositoryRoot ?? (await inspectionRoot(cwd, false)).root
  );
}

export async function readCheckoutCommandFile(
  cwd: string,
  file: string,
  {
    configuredRoot,
    exact = false,
  }: { configuredRoot?: string; exact?: boolean } = {}
) {
  const root = exact ? await realpath(cwd) : await effectiveCommandRoot(cwd);
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
  parseDefinition?: DefinitionParser;
  /**
   * Consult the base a runner recorded in Git config when the service sent
   * none. Runner checkouts keep it for older services and rows; the native
   * executor always receives the service's base and skips it.
   */
  recordedBase?: boolean;
  /** Native owner reviews attempt this ref if the usual Git probes fail. */
  unresolvedBase?: string;
};

export function inspectCheckout(
  cwd: string,
  query: Extract<CheckoutQuery, { kind: "defaultBranchFiles" }>,
  options: InspectCheckoutOptions & { parseDefinition: DefinitionParser }
): Promise<CheckoutReply>;
export function inspectCheckout(
  cwd: string,
  query: Exclude<CheckoutQuery, { kind: "defaultBranchFiles" }>,
  options?: InspectCheckoutOptions
): Promise<CheckoutReply>;
export function inspectCheckout(
  cwd: string,
  query: CheckoutQuery,
  options: InspectCheckoutOptions & { parseDefinition: DefinitionParser }
): Promise<CheckoutReply>;
export async function inspectCheckout(
  cwd: string,
  query: CheckoutQuery,
  {
    recordedBase = true,
    unresolvedBase,
    parseDefinition,
  }: InspectCheckoutOptions = {}
): Promise<CheckoutReply> {
  const validated = parseQuery(query);
  if (validated.kind === "defaultBranchFiles") {
    const reply = await defaultBranchFiles.get(
      cwd,
      validated.directories,
      validated.waitForRefresh,
      parseDefinition!
    );
    return reply;
  }
  if (validated.kind === "roots")
    return { kind: "roots", ...(await resolveInspectionRoots(cwd)) };
  const { root } = await inspectionRoot(cwd, validated.kind === "changes");
  if (validated.kind === "listFiles") {
    const canonicalRoot = await realpath(root);
    const directoryPath = path.join(
      canonicalRoot,
      ...validateFilePath(validated.path)
    );
    try {
      // Persona directories and files may be symlinks: list through them.
      const directory = await opendir(directoryPath);
      const names: string[] = [];
      try {
        for await (const entry of directory) {
          if (entry.name.toLowerCase() === ".git") continue;
          if (
            entry.isFile() ||
            (entry.isSymbolicLink() &&
              (await statPath(path.join(directoryPath, entry.name))
                .then((target) => target.isFile())
                .catch(() => false)))
          )
            names.push(entry.name);
        }
      } finally {
        // Iterating to the end closes it already; Node rejects a second close.
        try {
          await directory.close();
        } catch {
          // Already closed.
        }
      }
      const reply = { kind: "listFiles" as const, names: names.sort() };
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
  return reply;
}

export async function runCheckoutInspectionCli(
  cwd: string,
  parseDefinition: DefinitionParser
): Promise<void> {
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
    const reply = await inspectCheckout(cwd, query, { parseDefinition });
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
