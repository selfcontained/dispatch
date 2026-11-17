// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  announceAttentionToast,
  AttentionToasts,
  type AttentionToastEvent,
} from "./attention-toast";

let navigateTo: ((path: string) => void) | null = null;
function NavigateHandle() {
  const navigate = useNavigate();
  navigateTo = navigate;
  return null;
}

let seq = 0;
const event = (
  agentId: string,
  streamId: string | null
): AttentionToastEvent => {
  seq += 1;
  return {
    type: "attention.toast",
    toastId: `t-${seq}`,
    agentId,
    agentName: `Agent ${agentId}`,
    kind: "question",
    message: `Question ${seq}?`,
    target: streamId
      ? { streamId, threadId: null, blockId: `blk_${seq}` }
      : null,
  };
};

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <AttentionToasts isMobile={false} />
      <NavigateHandle />
    </MemoryRouter>
  );
}

async function announce(e: AttentionToastEvent) {
  await act(async () => {
    announceAttentionToast(e);
    // Sonner renders toasts on the next tick.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response(null, { status: 204 })))
  );
});

afterEach(() => {
  act(() => {
    toast.dismiss();
  });
  cleanup();
  vi.unstubAllGlobals();
  navigateTo = null;
});

describe("AttentionToasts", () => {
  it("doesn't toast the agent this tab has open", async () => {
    renderAt("/agents/agt_open");
    await announce(event("agt_open", "agt_open"));
    await announce(event("agt_open", null));
    expect(screen.queryAllByTestId("attention-toast")).toHaveLength(0);
  });

  it("doesn't toast another agent's item in the open agent's stream", async () => {
    renderAt("/agents/agt_open/changes");
    await announce(event("agt_child", "agt_open"));
    expect(screen.queryAllByTestId("attention-toast")).toHaveLength(0);
  });

  it("toasts a different agent", async () => {
    renderAt("/agents/agt_open");
    await announce(event("agt_other", "agt_other"));
    expect(await screen.findAllByTestId("attention-toast")).toHaveLength(1);
  });

  it("toasts the agent again once the tab navigates away from it", async () => {
    renderAt("/agents/agt_open");
    await announce(event("agt_open", "agt_open"));
    expect(screen.queryAllByTestId("attention-toast")).toHaveLength(0);
    act(() => navigateTo?.("/tasks"));
    await announce(event("agt_open", "agt_open"));
    expect(await screen.findAllByTestId("attention-toast")).toHaveLength(1);
  });

  it("doesn't toast an item with no text", async () => {
    renderAt("/tasks");
    await announce({ ...event("agt_other", "agt_other"), message: "  " });
    expect(screen.queryAllByTestId("attention-toast")).toHaveLength(0);
  });
});
