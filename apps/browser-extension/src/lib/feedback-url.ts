import type { SubmissionReceipt } from "../types";

/** Locate the post even when it lives in a child's launch-card thread. */
export function feedbackUrl(
  baseUrl: string,
  receipt: SubmissionReceipt
): string | null {
  if (!receipt.streamId || !receipt.blockId) return null;
  const url = new URL(
    `/agents/${encodeURIComponent(receipt.streamId)}`,
    baseUrl
  );
  if (receipt.threadId) url.searchParams.set("thread", receipt.threadId);
  url.searchParams.set("block", receipt.blockId);
  return url.toString();
}
