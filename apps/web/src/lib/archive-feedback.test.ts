import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Agent } from "@/components/app/types";
import { toast } from "@/components/ui/toast";

import { announceArchiveResult } from "./archive-feedback";

vi.mock("@/components/ui/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

beforeEach(() => vi.clearAllMocks());

const agent = (status: Agent["status"]) =>
  ({ id: "agt_1", name: "worker", status }) as Agent;

function archiveStarted() {
  const client = new QueryClient();
  client.setQueryData(["agents"], [agent("archiving")]);
  announceArchiveResult(client, agent("running"));
  return (agents: Agent[]) => client.setQueryData(["agents"], agents);
}

describe("announceArchiveResult", () => {
  it("announces the agent leaving the list", () => {
    archiveStarted()([]);
    expect(toast.success).toHaveBeenCalledWith("Agent “worker” archived.");
  });

  it("announces an archive that ends on an error", () => {
    archiveStarted()([agent("error")]);
    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it("stops watching an archive that was rolled back", () => {
    const set = archiveStarted();
    set([agent("stopped")]);
    set([]);
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });
});
