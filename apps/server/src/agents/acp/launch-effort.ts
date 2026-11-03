import type { Effort } from "@dispatch/shared";
import type { AcpDriver } from "./driver.js";
import type { AcpEngineId } from "./engine-spec.js";

/** Apply after model selection, before accepting the first prompt. */
export async function applyLaunchEffort(
  driver: Pick<AcpDriver, "getConfigOptions" | "setConfigOption">,
  agentId: string,
  engine: AcpEngineId,
  effort?: Effort | null
): Promise<void> {
  // Claude receives --effort at process creation through its SDK options.
  if (effort == null || engine === "claude") return;
  if (engine === "opencode") {
    throw new Error(
      "OpenCode does not support launch effort. Clear effort to inherit its settings."
    );
  }
  const option = driver
    .getConfigOptions(agentId)
    ?.find((item) => item.id === "reasoning_effort");
  if (!option || option.type !== "select") {
    throw new Error(
      "This Codex runtime does not expose reasoning_effort. Update Codex or clear the Dispatch default effort."
    );
  }
  const values = option.options.flatMap((item) =>
    "options" in item ? item.options.map((entry) => entry.value) : [item.value]
  );
  if (!values.includes(effort)) {
    throw new Error(
      `Codex does not support effort "${effort}" for this model. Choose ${values.join(", ") || "another model"}.`
    );
  }
  const result = await driver.setConfigOption(agentId, option.id, effort);
  if (result.find((item) => item.id === option.id)?.currentValue !== effort) {
    throw new Error(
      `Codex did not apply effort "${effort}". Choose a supported model and effort.`
    );
  }
}
