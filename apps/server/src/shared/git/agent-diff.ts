import { resolveBaseRef } from "./base-ref.js";
import {
  countLines,
  readUntrackedFile,
  shouldExcludePath,
} from "./diff-file-rules.js";
import { runCommand, type CommandRunner } from "../lib/run-command.js";

export type DiffFileStatus = "modified" | "added" | "deleted" | "renamed";

export type DiffFile = {
  path: string;
  status: DiffFileStatus;
  oldPath?: string;
  added: number;
  deleted: number;
  diff: string | null;
  truncated: boolean;
};

export type DiffResponse = {
  baseRef: string;
  files: DiffFile[];
  truncatedFileCount?: number;
};

export type FileDiffResponse = {
  path: string;
  status: DiffFileStatus;
  oldPath?: string;
  added: number;
  deleted: number;
  diff: string;
};

const GIT_TIMEOUT_MS = 15_000;
const DIFF_TRUNCATION_BYTES = 100_000;
const DIFF_TRUNCATION_LINES = 2_000;
const MAX_FILES = 1_000;

function parseStatusLetter(letter: string): DiffFileStatus {
  switch (letter) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "M":
      return "modified";
    default:
      if (letter.startsWith("R")) return "renamed";
      return "modified";
  }
}

type NumstatEntry = {
  path: string;
  oldPath?: string;
  status: DiffFileStatus;
  added: number;
  deleted: number;
};

function resolveRenamePath(raw: string): { dest: string; src?: string } {
  const braceMatch = /^(.*)\{(.+) => (.+)\}(.*)$/.exec(raw);
  if (!braceMatch) return { dest: raw };
  const prefix = braceMatch[1]!;
  const oldPart = braceMatch[2]!;
  const newPart = braceMatch[3]!;
  const suffix = braceMatch[4]!;
  return {
    dest: prefix + newPart + suffix,
    src: prefix + oldPart + suffix,
  };
}

function parseNumstatWithStatus(
  numstatOutput: string,
  statusOutput: string
): NumstatEntry[] {
  const statusMap = new Map<
    string,
    { status: DiffFileStatus; oldPath?: string }
  >();
  for (const line of statusOutput.split("\n")) {
    if (!line) continue;
    const letter = line[0];
    if (!letter) continue;
    const rest = line.slice(1).trim();
    if (letter === "R" || line[0] === "R") {
      const parts = rest.split("\t");
      if (parts.length >= 2) {
        statusMap.set(parts[1]!, {
          status: "renamed",
          oldPath: parts[0],
        });
      }
    } else {
      statusMap.set(rest, { status: parseStatusLetter(letter) });
    }
  }

  const entries: NumstatEntry[] = [];
  for (const line of numstatOutput.split("\n")) {
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const [a, d, ...rest] = parts;
    const rawPath = rest.join("\t");
    if (!rawPath) continue;

    const resolved = resolveRenamePath(rawPath);
    const filePath = resolved.dest;
    if (shouldExcludePath(filePath)) continue;

    const isBinary = a === "-" && d === "-";
    const statusInfo = statusMap.get(filePath);

    entries.push({
      path: filePath,
      oldPath: statusInfo?.oldPath ?? resolved.src,
      status: statusInfo?.status ?? (resolved.src ? "renamed" : "modified"),
      added: isBinary ? 0 : Number.parseInt(a!, 10) || 0,
      deleted: isBinary ? 0 : Number.parseInt(d!, 10) || 0,
    });
  }

  return entries;
}

function splitUnifiedDiffByFile(rawDiff: string): Map<string, string> {
  const fileMap = new Map<string, string>();
  const diffHeaderRe = /^diff --git a\/.+ b\/(.+)$/;
  let currentPath: string | null = null;
  let currentLines: string[] = [];

  for (const line of rawDiff.split("\n")) {
    const match = diffHeaderRe.exec(line);
    if (match) {
      if (currentPath !== null) {
        fileMap.set(currentPath, currentLines.join("\n"));
      }
      currentPath = match[1]!;
      currentLines = [line];
    } else {
      currentLines.push(line);
    }
  }

  if (currentPath !== null) {
    fileMap.set(currentPath, currentLines.join("\n"));
  }

  return fileMap;
}

function isFileTruncated(diff: string): boolean {
  const byteSize = Buffer.byteLength(diff, "utf-8");
  if (byteSize > DIFF_TRUNCATION_BYTES) return true;
  let lineCount = 0;
  for (const ch of diff) {
    if (ch === "\n") lineCount++;
    if (lineCount > DIFF_TRUNCATION_LINES) return true;
  }
  return false;
}

function buildUntrackedDiff(filePath: string, content: string): string {
  const lines = content.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const header = [
    `diff --git a/${filePath} b/${filePath}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${filePath}`,
    `@@ -0,0 +1,${lines.length} @@`,
  ];
  const added = lines.map((l) => `+${l}`);
  return [...header, ...added].join("\n");
}

export async function getAgentDiff(
  worktreePath: string,
  baseRef: string | null,
  run: CommandRunner = runCommand,
  options?: { ignoreWhitespace?: boolean; includeUncommitted?: boolean }
): Promise<DiffResponse | null> {
  const resolvedBase = await resolveBaseRef(worktreePath, baseRef, {
    runCommand: run,
  });
  if (!resolvedBase) return null;

  const mergeBaseResult = await run(
    "git",
    ["-C", worktreePath, "merge-base", "HEAD", resolvedBase],
    { allowedExitCodes: [0, 1, 128], timeoutMs: 5_000 }
  );
  if (mergeBaseResult.exitCode !== 0 || !mergeBaseResult.stdout.trim()) {
    return null;
  }
  const mergeBaseSha = mergeBaseResult.stdout.trim();

  const wsFlag = options?.ignoreWhitespace ? ["-w"] : [];
  const includeUncommitted = options?.includeUncommitted !== false;
  const diffRange = includeUncommitted
    ? [mergeBaseSha]
    : [mergeBaseSha, "HEAD"];
  const [numstatResult, statusResult, diffResult, untrackedResult] =
    await Promise.all([
      run(
        "git",
        ["-C", worktreePath, "diff", ...diffRange, "--numstat", ...wsFlag],
        {
          allowedExitCodes: [0],
          timeoutMs: GIT_TIMEOUT_MS,
        }
      ),
      run(
        "git",
        ["-C", worktreePath, "diff", ...diffRange, "--name-status", ...wsFlag],
        {
          allowedExitCodes: [0],
          timeoutMs: GIT_TIMEOUT_MS,
        }
      ),
      run(
        "git",
        [
          "-C",
          worktreePath,
          "diff",
          ...diffRange,
          "-U3",
          "--no-color",
          ...wsFlag,
        ],
        {
          allowedExitCodes: [0],
          timeoutMs: GIT_TIMEOUT_MS,
        }
      ),
      includeUncommitted
        ? run(
            "git",
            ["-C", worktreePath, "ls-files", "--others", "--exclude-standard"],
            {
              allowedExitCodes: [0],
              timeoutMs: GIT_TIMEOUT_MS,
            }
          )
        : Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
    ]);

  const entries = parseNumstatWithStatus(
    numstatResult.stdout,
    statusResult.stdout
  );
  const fileDiffs = splitUnifiedDiffByFile(diffResult.stdout);

  const files: DiffFile[] = entries.map((entry) => {
    const rawDiff = fileDiffs.get(entry.path) ?? null;
    const truncated = rawDiff !== null && isFileTruncated(rawDiff);
    return {
      path: entry.path,
      status: entry.status,
      ...(entry.oldPath ? { oldPath: entry.oldPath } : {}),
      added: entry.added,
      deleted: entry.deleted,
      diff: truncated ? null : rawDiff,
      truncated,
    };
  });

  const trackedPaths = new Set(entries.map((e) => e.path));
  const untrackedPaths = untrackedResult.stdout
    .split("\n")
    .filter((p) => p && !shouldExcludePath(p) && !trackedPaths.has(p));

  for (const filePath of untrackedPaths) {
    const { lines, content } = await readUntrackedFile(worktreePath, filePath);
    if (lines === 0 && content === null) {
      files.push({
        path: filePath,
        status: "added" as DiffFileStatus,
        added: 0,
        deleted: 0,
        diff: null,
        truncated: false,
      });
    } else {
      const syntheticDiff = buildUntrackedDiff(filePath, content!);
      const truncated = isFileTruncated(syntheticDiff);
      files.push({
        path: filePath,
        status: "added" as DiffFileStatus,
        added: lines,
        deleted: 0,
        diff: truncated ? null : syntheticDiff,
        truncated,
      });
    }
  }

  const totalFiles = files.length;
  if (totalFiles > MAX_FILES) {
    return {
      baseRef: mergeBaseSha,
      files: files.slice(0, MAX_FILES),
      truncatedFileCount: totalFiles,
    };
  }

  return { baseRef: mergeBaseSha, files };
}

export async function getAgentFileDiff(
  worktreePath: string,
  baseRef: string | null,
  filePath: string,
  run: CommandRunner = runCommand,
  options?: { ignoreWhitespace?: boolean; includeUncommitted?: boolean }
): Promise<FileDiffResponse | null> {
  const resolvedBase = await resolveBaseRef(worktreePath, baseRef, {
    runCommand: run,
  });
  if (!resolvedBase) return null;

  const mergeBaseResult = await run(
    "git",
    ["-C", worktreePath, "merge-base", "HEAD", resolvedBase],
    { allowedExitCodes: [0, 1, 128], timeoutMs: 5_000 }
  );
  if (mergeBaseResult.exitCode !== 0 || !mergeBaseResult.stdout.trim()) {
    return null;
  }
  const mergeBaseSha = mergeBaseResult.stdout.trim();

  const wsFlag2 = options?.ignoreWhitespace ? ["-w"] : [];
  const includeUncommitted = options?.includeUncommitted !== false;
  const diffRange2 = includeUncommitted
    ? [mergeBaseSha]
    : [mergeBaseSha, "HEAD"];
  const [numstatResult, statusResult, diffResult] = await Promise.all([
    run(
      "git",
      [
        "-C",
        worktreePath,
        "diff",
        ...diffRange2,
        "--numstat",
        ...wsFlag2,
        "--",
        filePath,
      ],
      { allowedExitCodes: [0], timeoutMs: GIT_TIMEOUT_MS }
    ),
    run(
      "git",
      [
        "-C",
        worktreePath,
        "diff",
        ...diffRange2,
        "--name-status",
        ...wsFlag2,
        "--",
        filePath,
      ],
      { allowedExitCodes: [0], timeoutMs: GIT_TIMEOUT_MS }
    ),
    run(
      "git",
      [
        "-C",
        worktreePath,
        "diff",
        ...diffRange2,
        "-U3",
        "--no-color",
        ...wsFlag2,
        "--",
        filePath,
      ],
      { allowedExitCodes: [0], timeoutMs: GIT_TIMEOUT_MS }
    ),
  ]);

  const entries = parseNumstatWithStatus(
    numstatResult.stdout,
    statusResult.stdout
  );

  if (entries.length === 0) {
    if (includeUncommitted) {
      const { lines, content } = await readUntrackedFile(
        worktreePath,
        filePath
      );
      if (lines === 0 && content === null) return null;
      return {
        path: filePath,
        status: "added" as DiffFileStatus,
        added: lines,
        deleted: 0,
        diff: buildUntrackedDiff(filePath, content!),
      };
    }
    return null;
  }

  const entry = entries[0]!;
  return {
    path: entry.path,
    status: entry.status,
    ...(entry.oldPath ? { oldPath: entry.oldPath } : {}),
    added: entry.added,
    deleted: entry.deleted,
    diff: diffResult.stdout,
  };
}
