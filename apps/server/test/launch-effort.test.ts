import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import { applyLaunchEffort } from "../src/agents/acp/launch-effort.js";

function driver(options: SessionConfigOption[] = []) {
  return {
    getConfigOptions: vi.fn(() => options),
    setConfigOption: vi.fn(
      async (_id: string, configId: string, value: string) =>
        options.map((option) =>
          option.id === configId ? { ...option, currentValue: value } : option
        )
    ),
  };
}

const reasoning: SessionConfigOption = {
  id: "reasoning_effort",
  name: "Reasoning effort",
  type: "select",
  currentValue: "medium",
  options: ["low", "medium", "high", "xhigh"].map((value) => ({
    value,
    name: value,
  })),
};

describe("launch effort", () => {
  it("maps Codex effort through the model's advertised reasoning option", async () => {
    const runtime = driver([reasoning]);
    await applyLaunchEffort(runtime, "agent", "codex", "xhigh");
    expect(runtime.setConfigOption).toHaveBeenCalledWith(
      "agent",
      "reasoning_effort",
      "xhigh"
    );
  });

  it("rejects unsupported models, levels and runtimes instead of silently falling back", async () => {
    await expect(
      applyLaunchEffort(driver(), "agent", "codex", "high")
    ).rejects.toThrow("does not expose effort");
    await expect(
      applyLaunchEffort(driver([reasoning]), "agent", "codex", "max")
    ).rejects.toThrow('does not support effort "max"');
    await expect(
      applyLaunchEffort(driver(), "agent", "opencode", "high")
    ).rejects.toThrow("opencode does not expose effort");
  });

  it("rejects an adapter that did not apply the selected effort", async () => {
    const runtime = driver([reasoning]);
    runtime.setConfigOption.mockResolvedValue([reasoning]);
    await expect(
      applyLaunchEffort(runtime, "agent", "codex", "high")
    ).rejects.toThrow("did not apply");
  });

  it.each(["claude", "codex", "opencode"] as const)(
    "leaves %s settings alone when effort is absent",
    async (engine) => {
      const runtime = driver();
      await applyLaunchEffort(runtime, "agent", engine, null);
      expect(runtime.setConfigOption).not.toHaveBeenCalled();
    }
  );
});

it("resumes an existing agent when its saved effort is no longer supported", async () => {
  const onError = vi.fn();
  const runtime = driver([reasoning]);
  await expect(
    applyLaunchEffort(runtime, "agent", "codex", "removed", { onError })
  ).resolves.toBeUndefined();
  expect(onError).toHaveBeenCalledOnce();
  expect(runtime.setConfigOption).not.toHaveBeenCalled();
});
