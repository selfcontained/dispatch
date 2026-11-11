import type { Block } from "./block-types.js";

/** Trusted server metadata on text blocks; never accepted by agent post/update. */
export interface SystemEvent {
  version: 1;
  category: "risk" | "checks" | "lifecycle" | "info";
  summary: string;
  risk?: "routine" | "human_review" | "abstain";
  status?: "Passing" | "Failing" | "Pending" | "Mixed";
  head?: string;
}

export function parseSystemEvent(value: unknown): SystemEvent | undefined {
  if (!value || typeof value !== "object") return;
  const e = value as Record<string, unknown>;
  if (
    e.version !== 1 ||
    !["risk", "checks", "lifecycle", "info"].includes(String(e.category)) ||
    typeof e.summary !== "string" ||
    !e.summary.trim() ||
    e.summary.length > 160 ||
    (e.head !== undefined &&
      (typeof e.head !== "string" || !/^[a-zA-Z0-9]{1,64}$/.test(e.head))) ||
    (e.risk !== undefined &&
      !["routine", "human_review", "abstain"].includes(String(e.risk))) ||
    (e.status !== undefined &&
      !["Passing", "Failing", "Pending", "Mixed"].includes(String(e.status))) ||
    (e.risk !== undefined && e.category !== "risk") ||
    (e.status !== undefined && e.category !== "checks")
  )
    return;
  return {
    version: 1,
    category: e.category as SystemEvent["category"],
    summary: e.summary,
    ...(e.risk ? { risk: e.risk as SystemEvent["risk"] } : {}),
    ...(e.status ? { status: e.status as SystemEvent["status"] } : {}),
    ...(e.head ? { head: e.head as string } : {}),
  };
}

/** Read-only projection: old observations remain durable text; no history rewrite. */
export function systemEventOf(block: Block): SystemEvent | undefined {
  if (block.kind !== "text" || block.author.kind !== "system") return;
  const explicit = parseSystemEvent(block.data?.systemEvent);
  if (explicit) return explicit;
  const transition = block.data?.pullRequestTransition as
    | {
        observation?: string;
        recommendation?: string;
        current?: string;
        headSha?: string;
      }
    | undefined;
  if (transition) {
    const category =
      transition.observation === "merge_risk"
        ? "risk"
        : transition.observation === "checks"
          ? "checks"
          : "lifecycle";
    const risk =
      transition.recommendation === "Routine change recommendation"
        ? "routine"
        : transition.recommendation === "Human review recommended"
          ? "human_review"
          : transition.recommendation ===
              "Inconclusive — no confident recommendation"
            ? "abstain"
            : undefined;
    return (
      parseSystemEvent({
        version: 1,
        category,
        summary:
          category === "risk"
            ? "Merge-risk assessment"
            : category === "checks"
              ? "Pull request checks"
              : `Pull request ${typeof transition.current === "string" ? transition.current.toLowerCase() : "updated"}`,
        ...(risk ? { risk } : {}),
        ...(transition.headSha ? { head: transition.headSha } : {}),
      }) ?? { version: 1, category: "info", summary: "System update" }
    );
  }
  if (block.data?.scheduledMessageId)
    return {
      version: 1,
      category: "info",
      summary: block.toAgentId ? "Scheduled delivery" : "Scheduled reminder",
    };
  return { version: 1, category: "info", summary: "System update" };
}
