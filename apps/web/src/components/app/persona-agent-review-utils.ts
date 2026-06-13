import type { ReviewVerdict } from "@/components/app/agent-event-utils";
import type { Agent } from "@/components/app/types";

export function getVerdict(child: Agent): ReviewVerdict | undefined {
  const v = child.review?.verdict;
  if (v === "approve" || v === "request_changes") return v;
  return undefined;
}

export function getReviewSummary(child: Agent): string | undefined {
  return child.review?.summary ?? undefined;
}

export function getFilesReviewed(child: Agent): string[] | undefined {
  const f = child.review?.filesReviewed;
  return Array.isArray(f) ? f : undefined;
}

export function getResolution(child: Agent) {
  return child.review?.resolution ?? undefined;
}
