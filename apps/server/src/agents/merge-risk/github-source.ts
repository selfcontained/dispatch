import type { GitHubPullRequestDetails } from "@dispatch/runner-protocol";
import { nativeGitHubEvidence } from "../github-pull-request-evidence.js";
import {
  createPullRequestReader,
  githubPullRequestTarget,
  projectPullRequest,
} from "../pull-request-reader.js";
import type { RemoteRunnerService } from "../remote/service.js";
import { mentionedText, selectHunks } from "./explanation-diff.js";

type Runners = Pick<
  RemoteRunnerService,
  "readPullRequestDetails" | "readPullRequestDiff"
>;

export function mergeRiskScope(
  runnerId: string | null,
  credentialContext: string
) {
  return JSON.stringify([runnerId, credentialContext]);
}

export function createMergeRiskGitHubSource(remote: Runners | undefined) {
  const native = nativeGitHubEvidence();
  const oldStatus = createPullRequestReader();
  return {
    async nativeStatus(url: string, title: string) {
      const target = githubPullRequestTarget(url);
      if (target) {
        const observation = await native
          .status(target, AbortSignal.timeout(12000))
          .catch(() => null);
        if (observation) return projectPullRequest(url, title, observation);
      }
      return oldStatus(url, title);
    },
    async details(
      runnerId: string | null,
      url: string
    ): Promise<GitHubPullRequestDetails | null> {
      const target = githubPullRequestTarget(url);
      if (!target) return null;
      try {
        return runnerId === null
          ? await native.details(target, AbortSignal.timeout(12000))
          : ((await remote?.readPullRequestDetails(runnerId, url)) ?? null);
      } catch {
        return null;
      }
    },
    async diff(
      runnerId: string | null,
      url: string,
      base: string,
      head: string,
      credentialContext: string,
      evidence: unknown
    ) {
      const target = githubPullRequestTarget(url);
      if (
        !target ||
        !/^[0-9a-f]{40}$/i.test(base) ||
        !/^[0-9a-f]{40}$/i.test(head)
      )
        return null;
      try {
        const result =
          runnerId === null
            ? await native.diff(
                {
                  ...target,
                  type: "pullRequestDiff",
                  base,
                  head,
                  credentialContext,
                },
                AbortSignal.timeout(20000)
              )
            : await remote?.readPullRequestDiff(
                runnerId,
                url,
                base,
                head,
                credentialContext
              );
        return result?.files.length
          ? { base, ...selectHunks(result.files, mentionedText(evidence)) }
          : null;
      } catch {
        return null;
      }
    },
  };
}

export type MergeRiskGitHubSource = ReturnType<
  typeof createMergeRiskGitHubSource
>;
