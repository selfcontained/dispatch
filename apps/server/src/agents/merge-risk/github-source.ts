import type { Runner } from "@dispatch/runner-protocol/contract";
import { mentionedText, selectHunks } from "./explanation-diff.js";

/**
 * Which saved assessments a placement may reuse. Local reads use the user's
 * own `gh` unscoped, as on main, so local records keep main's empty scope.
 * A runner's reads are scoped to its credential.
 */
export function mergeRiskScope(
  runnerId: string | null,
  credentialContext: string | undefined
): string | null {
  if (runnerId === null) return "";
  return credentialContext
    ? JSON.stringify([runnerId, credentialContext])
    : null;
}

/** owner/repo/number as written in the URL, as main passed them to `gh`. */
function target(url: string) {
  try {
    const match = new URL(url).pathname.match(
      /^\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)\/?$/
    );
    return match
      ? { owner: match[1]!, repo: match[2]!, number: Number(match[3]) }
      : null;
  } catch {
    return null;
  }
}

/**
 * Merge-risk evidence as the tracking agent's runner reads it: one call for
 * every placement.
 */
export function createMergeRiskGitHubSource(
  runnerFor: (runnerId: string | null) => Pick<Runner, "call">
) {
  return {
    /** Null when the URL is not a pull request or GitHub cannot read it. */
    async details(runnerId: string | null, url: string) {
      const pr = target(url);
      if (!pr) return null;
      return runnerFor(runnerId).call("github.pr.details", pr);
    },
    /**
     * Hunks for an explanation. Without `base`, the pull request's current
     * base; `context` is the credential the assessment was read with.
     */
    async diff(
      runnerId: string | null,
      url: string,
      base: string | null,
      head: string,
      context: string | undefined,
      evidence: unknown
    ) {
      const pr = target(url);
      if (!pr) return null;
      try {
        const result = await runnerFor(runnerId).call("github.pr.diff", {
          ...pr,
          ...(base !== null && { base }),
          head,
          ...(context !== undefined && { context }),
        });
        return result?.files.length
          ? {
              base: base ?? result.base ?? "",
              ...selectHunks(result.files, mentionedText(evidence)),
            }
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
