import { execFile } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { promisify } from "node:util";
import {
  isGitHubPullRequestDetails,
  isGitHubPullRequestDiff,
  type GitHubOperation,
  type GitHubPullRequestTarget,
} from "@dispatch/runner-protocol";
import {
  pullRequestObservation,
  pullRequestQueryArgs,
} from "./pull-request-reader.js";

type Run = (
  args: string[],
  signal: AbortSignal,
  token?: string
) => Promise<string>;
const host = ["--hostname", "github.com"];
const execute = promisify(execFile);

export function nativeGitHubEvidence() {
  return new GitHubPullRequestEvidence(async (args, signal, token) => {
    const { stdout } = await execute("gh", args, {
      signal,
      timeout: 7000,
      killSignal: "SIGKILL",
      maxBuffer: 128 * 1024,
      env: {
        ...process.env,
        GH_PROMPT_DISABLED: "1",
        ...(token && { GH_TOKEN: token }),
      },
    });
    return stdout.trim();
  });
}

const DETAILS_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      number title body baseRefName headRefName baseRefOid headRefOid additions deletions
      files(first: 100) { pageInfo { hasNextPage } nodes { path additions deletions } }
    }
  }
}`;

/** Every provider read in an operation uses the same token, even if gh's
 * active account changes while the request is running. */
export class GitHubPullRequestEvidence {
  constructor(
    private readonly run: Run,
    private readonly credentialKey?: Buffer
  ) {}

  private async credential(signal: AbortSignal) {
    const token = await this.run(["auth", "token", ...host], signal);
    if (!token || !/^[\w.-]{1,1024}$/.test(token))
      throw new Error("GitHub credential unavailable.");
    const digest = this.credentialKey
      ? createHmac("sha256", this.credentialKey)
      : createHash("sha256");
    const credentialContext = digest
      .update("github.com/pull-request-evidence\0")
      .update(token)
      .digest("hex");
    return { token, credentialContext };
  }

  async status(target: GitHubPullRequestTarget, signal: AbortSignal) {
    const { token, credentialContext } = await this.credential(signal);
    const result = await this.run(
      pullRequestQueryArgs(target.owner, target.repo, String(target.number)),
      signal,
      token
    ).catch((error) => {
      if (error.code === 1 && typeof error.stdout === "string" && error.stdout)
        return error.stdout;
      throw error;
    });
    return { ...pullRequestObservation(JSON.parse(result)), credentialContext };
  }

  async details(
    { owner, repo, number }: GitHubPullRequestTarget,
    signal: AbortSignal
  ) {
    const { token, credentialContext } = await this.credential(signal);
    const result = JSON.parse(
      await this.run(
        [
          "api",
          "graphql",
          ...host,
          "-f",
          `query=${DETAILS_QUERY}`,
          "-f",
          `owner=${owner}`,
          "-f",
          `repo=${repo}`,
          "-F",
          `number=${number}`,
        ],
        signal,
        token
      )
    );
    const pr = result?.data?.repository?.pullRequest;
    if (pr?.number !== number || pr.files?.pageInfo?.hasNextPage !== false)
      return null;
    const value: unknown = { ...pr, credentialContext, files: pr.files.nodes };
    return isGitHubPullRequestDetails(value) ? value : null;
  }

  async diff(
    operation: Extract<GitHubOperation, { type: "pullRequestDiff" }>,
    signal: AbortSignal
  ) {
    const { owner, repo, number, base, head } = operation;
    const { token, credentialContext } = await this.credential(signal);
    if (operation.credentialContext !== credentialContext) return null;
    const repository = `repos/${owner}/${repo}`;
    const accessible = await this.run(
      ["api", ...host, `${repository}/pulls/${number}`, "--jq", ".number"],
      signal,
      token
    );
    if (accessible !== String(number)) return null;
    const files: unknown = JSON.parse(
      await this.run(
        [
          "api",
          ...host,
          `${repository}/compare/${base}...${head}`,
          "--jq",
          '[.files[] | {path: .filename, additions, deletions, patch: (.patch | if type == "string" and length <= 32768 then . else null end)} | del(.patch | nulls)]',
        ],
        signal,
        token
      )
    );
    const value = { files };
    return isGitHubPullRequestDiff(value) ? value : null;
  }
}
