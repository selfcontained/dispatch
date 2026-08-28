import { useAtom } from "jotai";

import { surfaceFormDraftAtomFamily } from "@/lib/store";

export function surfaceFormDraftKey(
  agentId: string,
  surfaceId: string,
  blockId: string
): string {
  return `${agentId}:${surfaceId}:${blockId}`;
}

/** Unsubmitted form input, persisted locally per agent+surface+form block. */
export function useSurfaceFormDraft(
  agentId: string,
  surfaceId: string,
  blockId: string
) {
  return useAtom(
    surfaceFormDraftAtomFamily(surfaceFormDraftKey(agentId, surfaceId, blockId))
  );
}
