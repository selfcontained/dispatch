import type { Step } from "./contracts";
import { activitySteps } from "./activity-steps";
import { activityCategory, type ActivityCategory } from "./activity-category";

export type ResponsePiece = {
  key: string;
  category: ActivityCategory;
  label: string;
  compaction?: boolean;
};

/** First-seen identities prevent late children from reordering existing work. */
export function responsePieces(
  previous: ResponsePiece[] | null,
  steps: Step[],
  writes: number,
  thinkingKey?: string
): ResponsePiece[] {
  const current = new Map<string, ResponsePiece>();
  for (const step of activitySteps(steps)) {
    current.set(`step:${step.id}`, {
      key: `step:${step.id}`,
      category: step.kind === "compaction" ? "checks" : activityCategory(step),
      ...(step.kind === "compaction" ? { compaction: true } : {}),
      label: step.label || step.kind,
    });
  }
  if (thinkingKey)
    current.set(thinkingKey, {
      key: thinkingKey,
      category: "think",
      label: "Thinking",
    });
  const pieces = [...current.values()];
  const writing = (i: number): ResponsePiece => ({
    key: `write:${i}`,
    category: "write",
    label: "Progress text",
  });
  if (previous === null) {
    // A turn opened mid-stream has no arrival history for text chunks.
    const initial: ResponsePiece[] = [];
    let written = 0;
    pieces.forEach((piece, i) => {
      initial.push(piece);
      const due = Math.floor(((i + 1) * writes) / pieces.length);
      while (written < due) initial.push(writing(written++));
    });
    while (written < writes) initial.push(writing(written++));
    return initial;
  }
  let changed = false;
  const next = previous.map((piece) => {
    const updated = current.get(piece.key);
    if (
      updated &&
      (updated.category !== piece.category ||
        updated.label !== piece.label ||
        updated.compaction !== piece.compaction)
    ) {
      changed = true;
      return updated;
    }
    return piece;
  });
  const known = new Set(previous.map((piece) => piece.key));
  for (let i = 0; i < writes; i++) pieces.push(writing(i));
  for (const piece of pieces) {
    if (!known.has(piece.key)) {
      next.push(piece);
      known.add(piece.key);
      changed = true;
    }
  }
  return changed ? next : previous;
}
