import { createHash } from "node:crypto";
import type { AgentPullRequest } from "@dispatch/shared";
import { formatPullRequestLink } from "./pull-request-check-notice.js";

/** Only completed, current recommendations qualify; history/progress is silent. */
export function riskNotice(pr: AgentPullRequest, agentId: string) {
  const risk = pr.mergeRisk;
  if (
    !risk?.assessmentId ||
    risk.status !== "ok" ||
    risk.displayState ||
    !risk.headSha ||
    risk.headSha !== pr.ci?.headSha ||
    (pr.status !== "Open" && pr.status !== "Draft")
  )
    return undefined;
  const hash = createHash("sha256")
    .update(JSON.stringify([agentId, pr.url, risk.assessmentId]))
    .digest("hex");
  const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  const recommendation =
    risk.verdict === "routine"
      ? "Routine change recommendation"
      : risk.verdict === "human_review"
        ? "Human review recommended"
        : "Inconclusive — no confident recommendation";
  const head = risk.headSha.replace(/[^a-zA-Z0-9]/g, "").slice(0, 40);
  return {
    id,
    text: `${formatPullRequestLink(pr)} — Merge-risk assessment: ${recommendation}.\nAssessed head: ${head}. Info only; not merge approval or authorization.`,
    assessmentId: risk.assessmentId,
    recommendation,
  };
}
