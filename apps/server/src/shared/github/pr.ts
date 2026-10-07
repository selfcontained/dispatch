import {
  resolveCheckoutRootOrThrow,
  resolveCurrentBranch,
} from "../git/git-context.js";
import { runCommand, type CommandRunner } from "../lib/run-command.js";

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
  statusSummary: Array<{
    name: string;
    status: string;
    conclusion: string | null;
  }>;
};

export class GitHubPrError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "GitHubPrError";
    this.statusCode = statusCode;
  }
}

export async function getPrStatus(
  input: GetPrStatusInput,
  commandRunner: CommandRunner = runCommand
): Promise<GetPrStatusResult> {
  const cwd = requireString(input.cwd, "cwd");
  const repoRoot = await resolveCheckoutRootOrThrow(
    cwd,
    commandRunner,
    GitHubPrError
  );

  const args = [
    "pr",
    "view",
    "--json",
    "number,url,title,state,isDraft,reviewDecision,mergeStateStatus,mergeable,autoMergeRequest,headRefName,baseRefName,statusCheckRollup",
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
    autoMergeEnabled:
      parsed.autoMergeRequest !== null && parsed.autoMergeRequest !== undefined,
    headRefName: stringField(parsed.headRefName, "headRefName"),
    baseRefName: stringField(parsed.baseRefName, "baseRefName"),
    statusSummary: parseStatusCheckRollup(parsed.statusCheckRollup),
  };
}

function requireString(value: string | undefined, fieldName: string): string {
  const normalized = value?.trim() ?? "";
  if (!normalized) {
    throw new GitHubPrError(`${fieldName} is required.`, 400);
  }
  return normalized;
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

function parseStatusCheckRollup(
  value: unknown
): Array<{ name: string; status: string; conclusion: string | null }> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (!item || typeof item !== "object") {
      return [];
    }

    const record = item as Record<string, unknown>;
    const name =
      typeof record.name === "string"
        ? record.name
        : typeof record.context === "string"
          ? record.context
          : "unknown";
    const status =
      typeof record.status === "string" ? record.status : "UNKNOWN";
    const conclusion =
      typeof record.conclusion === "string" ? record.conclusion : null;
    return [{ name, status, conclusion }];
  });
}
