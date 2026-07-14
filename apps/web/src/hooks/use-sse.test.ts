// @vitest-environment jsdom
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { agentDiffQueryKey } from "@/hooks/use-agent-diff";
import { diffStatsQueryKey } from "@/hooks/use-agent-diff-stats";

import { applyDiffStateChanged } from "./use-sse";

describe("applyDiffStateChanged", () => {
  it("updates pushed stats and invalidates only committed-only stats", () => {
    const queryClient = new QueryClient();
    const includeUncommittedKey = diffStatsQueryKey("agent-1", true);
    const committedOnlyKey = diffStatsQueryKey("agent-1", false);
    const contentKey = [...agentDiffQueryKey("agent-1"), false, true] as const;

    queryClient.setQueryData(includeUncommittedKey, { added: 1, deleted: 1 });
    queryClient.setQueryData(committedOnlyKey, { added: 2, deleted: 2 });
    queryClient.setQueryData(contentKey, { files: [] });
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const pushedStats = {
      added: 3,
      deleted: 4,
      files: 2,
      computedAt: 123,
    };

    applyDiffStateChanged(queryClient, "agent-1", pushedStats);

    expect(queryClient.getQueryData(includeUncommittedKey)).toEqual(
      pushedStats
    );
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: committedOnlyKey,
      exact: true,
    });
    expect(invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: includeUncommittedKey,
      exact: true,
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: agentDiffQueryKey("agent-1"),
    });
  });
});
