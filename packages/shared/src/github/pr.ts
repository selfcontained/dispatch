import { runCommand, type RunCommandResult } from "../lib/run-command.js";

type CommandRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string; allowedExitCodes?: number[]; timeoutMs?: number }
) => Promise<RunCommandResult>;

export type CreatePrInput = {
  cwd: string;
  baseBranch?: string;
  title?: string;
  body?: string;
  draft?: boolean;
  fillFromCommits?: boolean;
};

export type CreatePrResult = {
  repoRoot: string;
  branchName: string;
  baseBranch: string;
  prNumber: number | null;
  url: string;
  title: string | null;
  isDraft: boolean | null;
};

export type GetPrStatusInput = {
  cwd: string;
  prNumber?: number;
};

export type GetPrStatusResult = {
  number: number;
  url: string;
  title: string;
  state: string;
  isDraft: boolean;
  reviewDecision: string | null;
  mergeStateStatus: string | null;
  mergeable: string | null;
  autoMergeEnabled: boolean;
  headRefName: string;
  baseRefName: string;
  statusSummary: Array<{ name: string; status: string; conclusion: string | null }>;
};

export class GitHubPrError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "GitHubPrError";
    this.statusCode = statusCode;
  }
}

export async function createPr(
  input: CreatePrInput,
  commandRunner: CommandRunner = runCommand
): Promise<CreatePrResult> {
  const cwd = requireString(input.cwd, "cwd");
  const repoRoot = await resolveRepoRoot(cwd, commandRunner);
  const baseBranch = (input.baseBranch?.trim() || "main");
  const branchName = await resolveCurrentBranch(repoRoot, commandRunner);

  if (!branchName) {
    throw new GitHubPrError("Current checkout is in detached HEAD state.", 409);
  }
  if (branchName === baseBranch) {
    throw new GitHubPrError(`Current branch is already "${baseBranch}". Create the PR from a feature branch instead.`, 409);
  }

  await ensureBaseBranchHasDiff(repoRoot, baseBranch, commandRunner);
  await ensureRemoteBranch(repoRoot, branchName, commandRunner);

  const args = ["pr", "create", "--base", baseBranch, "--head", branchName];
  if (input.draft ?? false) {
    args.push("--draft");
  }
  if (input.fillFromCommits ?? false) {
    args.push("--fill");
  }
  if (input.title?.trim()) {
    args.push("--title", input.title.trim());
  }
  if (input.body?.trim()) {
    args.push("--body", input.body.trim());
  }

  if (!args.includes("--title") && !args.includes("--fill")) {
    throw new GitHubPrError("create_pr requires title or fillFromCommits to avoid interactive gh prompts.", 400);
  }
  if (!args.includes("--body") && !args.includes("--fill")) {
    throw new GitHubPrError("create_pr requires body or fillFromCommits to avoid interactive gh prompts.", 400);
  }

  const createResult = await commandRunner("gh", args, { cwd: repoRoot });
  const url = firstNonEmptyLine(createResult.stdout);
  if (!url) {
    throw new GitHubPrError("gh pr create did not return a PR URL.", 500);
  }

  const status = await getPrStatus({ cwd: repoRoot, prNumber: undefined }, commandRunner);
  return {
    repoRoot,
    branchName,
    baseBranch,
    prNumber: status.number,
    url,
    title: status.title,
    isDraft: status.isDraft
  };
}

export async function getPrStatus(
  input: GetPrStatusInput,
  commandRunner: CommandRunner = runCommand
): Promise<GetPrStatusResult> {
  const cwd = requireString(input.cwd, "cwd");
  const repoRoot = await resolveRepoRoot(cwd, commandRunner);

  const args = [
    "pr", "view",
    "--json",
    "number,url,title,state,isDraft,reviewDecision,mergeStateStatus,mergeable,autoMergeRequest,headRefName,baseRefName,statusCheckRollup"
  ];
  if (input.prNumber) {
    args.splice(2, 0, String(input.prNumber));
  }

  const result = await commandRunner("gh", args, { cwd: repoRoot });
  const parsed = JSON.parse(result.stdout) as Record<string, unknown>;

  return {
    number: numberField(parsed.number, "number"),
    url: stringField(parsed.url, "url"),
    title: stringField(parsed.title, "title"),
    state: stringField(parsed.state, "state"),
    isDraft: booleanField(parsed.isDraft, "isDraft"),
    reviewDecision: optionalStringField(parsed.reviewDecision),
    mergeStateStatus: optionalStringField(parsed.mergeStateStatus),
    mergeable: optionalStringField(parsed.mergeable),
    autoMergeEnabled: parsed.autoMergeRequest !== null && parsed.autoMergeRequest !== undefined,
    headRefName: stringField(parsed.headRefName, "headRefName"),
    baseRefName: stringField(parsed.baseRefName, "baseRefName"),
    statusSummary: parseStatusCheckRollup(parsed.statusCheckRollup)
  };
}

async function resolveRepoRoot(cwd: string, commandRunner: CommandRunner): Promise<string> {
  try {
    return (
      await commandRunner("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { allowedExitCodes: [0] })
    ).stdout;
  } catch {
    throw new GitHubPrError("No git repository found for the provided working directory.", 404);
  }
}

async function resolveCurrentBranch(repoRoot: string, commandRunner: CommandRunner): Promise<string | null> {
  const result = await commandRunner(
    "git",
    ["-C", repoRoot, "symbolic-ref", "--short", "-q", "HEAD"],
    { allowedExitCodes: [0, 1] }
  );

  return result.exitCode === 0 && result.stdout ? result.stdout : null;
}

async function ensureBaseBranchHasDiff(repoRoot: string, baseBranch: string, commandRunner: CommandRunner): Promise<void> {
  await commandRunner("git", ["-C", repoRoot, "fetch", "origin", baseBranch, "--quiet"]);
  const diffCount = (
    await commandRunner("git", ["-C", repoRoot, "rev-list", "--count", `origin/${baseBranch}..HEAD`])
  ).stdout;
  if (Number(diffCount) <= 0) {
    throw new GitHubPrError(`Current branch has no commits ahead of origin/${baseBranch}.`, 409);
  }
}

async function ensureRemoteBranch(repoRoot: string, branchName: string, commandRunner: CommandRunner): Promise<void> {
  const hasUpstream = await commandRunner(
    "git",
    ["-C", repoRoot, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    { allowedExitCodes: [0, 128] }
  );

  if (hasUpstream.exitCode !== 0 || !hasUpstream.stdout) {
    await commandRunner("git", ["-C", repoRoot, "push", "--set-upstream", "origin", branchName]);
    return;
  }

  await commandRunner("git", ["-C", repoRoot, "push", "origin", branchName]);
}

function requireString(value: string | undefined, fieldName: string): string {
  const normalized = value?.trim() ?? "";
  if (!normalized) {
    throw new GitHubPrError(`${fieldName} is required.`, 400);
  }
  return normalized;
}

function firstNonEmptyLine(value: string): string | null {
  return value
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? null;
}

function stringField(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || !value) {
    throw new GitHubPrError(`Expected ${fieldName} in gh response.`, 500);
  }
  return value;
}

function optionalStringField(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function booleanField(value: unknown, fieldName: string): boolean {
  if (typeof value !== "boolean") {
    throw new GitHubPrError(`Expected ${fieldName} in gh response.`, 500);
  }
  return value;
}

function numberField(value: unknown, fieldName: string): number {
  if (typeof value !== "number") {
    throw new GitHubPrError(`Expected ${fieldName} in gh response.`, 500);
  }
  return value;
}

function parseStatusCheckRollup(value: unknown): Array<{ name: string; status: string; conclusion: string | null }> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (!item || typeof item !== "object") {
      return [];
    }

    const record = item as Record<string, unknown>;
    const name = typeof record.name === "string"
      ? record.name
      : typeof record.context === "string"
        ? record.context
        : "unknown";
    const status = typeof record.status === "string" ? record.status : "UNKNOWN";
    const conclusion = typeof record.conclusion === "string" ? record.conclusion : null;
    return [{ name, status, conclusion }];
  });
}
