import { describe, expect, it } from "vitest";

import {
  composerDisabledReason,
  composerWaitReason,
} from "@/components/app/chat/composer-disabled";
import { type Agent } from "@/components/app/types";

const agent = (status: Agent["status"]) => ({ status }) as Agent;

describe("composer readiness", () => {
  it("keeps a starting agent's composer editable but holds the send", () => {
    expect(composerDisabledReason(agent("creating"))).toBeNull();
    expect(composerWaitReason(agent("creating"))).toMatch(/starting up/);
  });

  it("neither disables nor holds a running agent's composer", () => {
    expect(composerDisabledReason(agent("running"))).toBeNull();
    expect(composerWaitReason(agent("running"))).toBeNull();
  });

  it("disables a stopped agent's composer without a wait", () => {
    expect(composerDisabledReason(agent("stopped"))).toMatch(/not running/);
    expect(composerWaitReason(agent("stopped"))).toBeNull();
  });

  it("still disables while the chat loads, even for a starting agent", () => {
    expect(
      composerDisabledReason(agent("creating"), {
        isLoading: true,
        error: null,
      })
    ).toBe("Loading the chat…");
  });
});
