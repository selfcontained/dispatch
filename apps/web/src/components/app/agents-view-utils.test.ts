// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import type { Agent } from "@/components/app/types";
import {
  agentProjectRoot,
  isFullAccessEnabled,
  readLastUsedAgentType,
  readExpandedAgentId,
  LAST_USED_TYPE_KEY,
  EXPANDED_AGENT_ID_KEY,
} from "./agents-view-utils";

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    name: "agent-1",
    status: "working",
    cwd: "/repo/cwd",
    worktreePath: null,
    worktreeBranch: null,
    tmuxSession: null,
    agentArgs: [],
    model: null,
    fullAccess: false,
    mediaDir: null,
    ...overrides,
  } as Agent;
}

describe("agentProjectRoot", () => {
  it("prefers gitContext.repoRoot over cwd when both are present", () => {
    const agent = makeAgent({
      cwd: "/repo/cwd",
      gitContext: {
        repoRoot: "/repo/root",
        branch: "main",
        worktreePath: "/repo/worktree",
        worktreeName: "wt",
        isWorktree: true,
      },
    });
    expect(agentProjectRoot(agent)).toBe("/repo/root");
  });

  it("trims whitespace from repoRoot", () => {
    const agent = makeAgent({
      gitContext: {
        repoRoot: "  /repo/root  ",
        branch: "main",
        worktreePath: "/repo/worktree",
        worktreeName: "wt",
        isWorktree: true,
      },
    });
    expect(agentProjectRoot(agent)).toBe("/repo/root");
  });

  it("falls back to cwd when repoRoot is empty/whitespace-only", () => {
    const agent = makeAgent({
      cwd: "  /repo/cwd  ",
      gitContext: {
        repoRoot: "   ",
        branch: "main",
        worktreePath: "/repo/worktree",
        worktreeName: "wt",
        isWorktree: true,
      },
    });
    expect(agentProjectRoot(agent)).toBe("/repo/cwd");
  });

  it("falls back to cwd when gitContext is absent", () => {
    const agent = makeAgent({ cwd: "/repo/cwd", gitContext: undefined });
    expect(agentProjectRoot(agent)).toBe("/repo/cwd");
  });

  it("returns undefined when both repoRoot and cwd are empty", () => {
    const agent = makeAgent({ cwd: "   ", gitContext: null });
    expect(agentProjectRoot(agent)).toBeUndefined();
  });

  it("returns undefined for a null or undefined agent", () => {
    expect(agentProjectRoot(null)).toBeUndefined();
    expect(agentProjectRoot(undefined)).toBeUndefined();
  });
});

describe("isFullAccessEnabled", () => {
  it("is true when agent.fullAccess is set, regardless of agentArgs", () => {
    expect(
      isFullAccessEnabled({ fullAccess: true, agentArgs: ["--verbose"] })
    ).toBe(true);
  });

  it("is true when agentArgs includes the Codex full-access flag", () => {
    expect(
      isFullAccessEnabled({
        fullAccess: false,
        agentArgs: ["--dangerously-bypass-approvals-and-sandbox"],
      })
    ).toBe(true);
  });

  it("is true when agentArgs includes the Claude full-access flag", () => {
    expect(
      isFullAccessEnabled({
        fullAccess: false,
        agentArgs: ["--dangerously-skip-permissions"],
      })
    ).toBe(true);
  });

  it("is false when fullAccess is false and no matching flag is present", () => {
    expect(
      isFullAccessEnabled({ fullAccess: false, agentArgs: ["--verbose"] })
    ).toBe(false);
  });

  it("is false for an agent with no args at all", () => {
    expect(isFullAccessEnabled({ fullAccess: false, agentArgs: [] })).toBe(
      false
    );
  });
});

describe("readLastUsedAgentType", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("returns null when nothing is stored", () => {
    expect(readLastUsedAgentType()).toBeNull();
  });

  it("returns the stored value when it is a valid agent type", () => {
    window.localStorage.setItem(LAST_USED_TYPE_KEY, "codex");
    expect(readLastUsedAgentType()).toBe("codex");
  });

  it("trims whitespace around a valid stored value", () => {
    window.localStorage.setItem(LAST_USED_TYPE_KEY, "  codex  ");
    expect(readLastUsedAgentType()).toBe("codex");
  });

  it("returns null when the stored value is not a valid agent type", () => {
    window.localStorage.setItem(LAST_USED_TYPE_KEY, "not-a-real-type");
    expect(readLastUsedAgentType()).toBeNull();
  });

  it("returns null when the stored value is only whitespace", () => {
    window.localStorage.setItem(LAST_USED_TYPE_KEY, "   ");
    expect(readLastUsedAgentType()).toBeNull();
  });
});

describe("readExpandedAgentId", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("returns null when nothing is stored", () => {
    expect(readExpandedAgentId()).toBeNull();
  });

  it("returns the stored id, trimmed", () => {
    window.localStorage.setItem(EXPANDED_AGENT_ID_KEY, "  agent-42  ");
    expect(readExpandedAgentId()).toBe("agent-42");
  });

  it("returns null when the stored value is only whitespace", () => {
    window.localStorage.setItem(EXPANDED_AGENT_ID_KEY, "   ");
    expect(readExpandedAgentId()).toBeNull();
  });
});
