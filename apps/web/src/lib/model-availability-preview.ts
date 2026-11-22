/**
 * DESIGN PREVIEW (tsk_bd9f120fe890): browser-local stand-in for the per-type
 * model availability setting. Nothing here reaches the server. Replace with
 * persisted settings once the design is approved; do not merge as is.
 */
import { atomWithLocalStorage } from "@/lib/store";
import type { AgentType } from "@/lib/agent-types";

type Model = {
  id: string;
  label: string;
  effort?: import("@dispatch/shared").AgentConfigChoice[];
};

export type TypeAvailability = {
  autoEnable: boolean;
  off: string[];
  /** The simulated release has happened. */
  released: boolean;
};

export type ModelAvailability = Partial<Record<AgentType, TypeAvailability>>;

export const INITIAL_AVAILABILITY: TypeAvailability = {
  autoEnable: true,
  off: [],
  released: false,
};

export const modelAvailabilityAtom = atomWithLocalStorage<ModelAvailability>(
  "dispatch:preview:model-availability:v3",
  {}
);

/** New models the person has seen in a list. */
export const seenModelsAtom = atomWithLocalStorage<string[]>(
  "dispatch:preview:models-seen:v3",
  []
);

/** The catalog as it would read after the simulated release. */
export function previewModels(
  type: AgentType,
  models: readonly Model[],
  released: boolean,
  seen: readonly string[]
): (Model & { isNew?: boolean })[] {
  if (!released || type !== "codex") return [...models];
  const id = "gpt-6.3-sol";
  return [{ id, label: "GPT-6.3 Sol", isNew: !seen.includes(id) }, ...models];
}

export function simulateRelease(state: TypeAvailability): TypeAvailability {
  const off = state.autoEnable ? state.off : [...state.off, "gpt-6.3-sol"];
  return { ...state, released: true, off };
}
