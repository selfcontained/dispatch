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
  "dispatch:preview:model-availability:v2",
  {}
);

/** New models the person has seen in a list. */
export const seenModelsAtom = atomWithLocalStorage<string[]>(
  "dispatch:preview:models-seen:v2",
  []
);

/** The catalog as it would read after the simulated release. */
export function previewModels(
  type: AgentType,
  models: readonly Model[],
  released: boolean,
  seen: readonly string[]
): (Model & { isNew?: boolean })[] {
  if (!released) return [...models];
  if (type === "codex") {
    const id = "gpt-6.3-sol";
    return [{ id, label: "GPT-6.3 Sol", isNew: !seen.includes(id) }, ...models];
  }
  if (type !== "claude") return [...models];
  return models.flatMap((model) =>
    model.id === "opus"
      ? [
          { ...model, label: "Opus 5.6", isNew: !seen.includes("opus") },
          { ...model, id: "claude-opus-5-5" },
        ]
      : [model]
  );
}

export function simulateRelease(
  type: AgentType,
  state: TypeAvailability
): TypeAvailability {
  // A checkbox belongs to the version, so it follows 5.5 off the alias.
  const off =
    type === "claude"
      ? state.off.map((id) => (id === "opus" ? "claude-opus-5-5" : id))
      : [...state.off];
  if (!state.autoEnable) off.push(type === "claude" ? "opus" : "gpt-6.3-sol");
  return { ...state, released: true, off };
}
