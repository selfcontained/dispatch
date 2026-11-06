import type { Effort } from "@dispatch/shared";
import type { AcpDriver } from "./driver.js";
import type { AcpEngineId } from "./engine-spec.js";

/** Apply after model selection, before accepting the first prompt. */
async function applyStrictLaunchEffort(
  driver: Pick<AcpDriver, "getConfigOptions" | "setConfigOption">,
  agentId: string,
  engine: AcpEngineId,
  effort?: Effort | null
): Promise<void> {
  if (effort == null) return;
  const option = driver
    .getConfigOptions(agentId)
    ?.find(
      (item) =>
        item.category === "thought_level" ||
        /effort|reasoning|thinking/i.test(item.id)
    );
  if (!option || option.type !== "select") {
    throw new Error(
      `${engine} does not expose effort for this model. Leave effort at Default.`
    );
  }
  const values = option.options.flatMap((item) =>
    "options" in item ? item.options.map((entry) => entry.value) : [item.value]
  );
  if (!values.includes(effort)) {
    throw new Error(
      `${engine} does not support effort "${effort}" for this model. Choose ${values.join(", ") || "another model"}.`
    );
  }
  const result = await driver.setConfigOption(agentId, option.id, effort);
  if (result.find((item) => item.id === option.id)?.currentValue !== effort) {
    throw new Error(
      `${engine} did not apply effort "${effort}". Choose a supported model and effort.`
    );
  }
}

/** A removed engine capability must not make an existing session unrecoverable. */
export async function applyLaunchEffort(
  driver: Pick<AcpDriver, "getConfigOptions" | "setConfigOption">,
  agentId: string,
  engine: AcpEngineId,
  effort?: Effort | null,
  resume?: { onError: (error: unknown) => void }
): Promise<void> {
  try {
    await applyStrictLaunchEffort(driver, agentId, engine, effort);
  } catch (error) {
    if (!resume) throw error;
    resume.onError(error);
  }
}
