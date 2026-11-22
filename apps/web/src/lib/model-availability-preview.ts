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
  /** What Default launches while the engine's own default is off. */
  replacement: string | null;
  /** The simulated release, and the policy in force when it was found. */
  release: "followed" | "held" | null;
};

export type ModelAvailability = Partial<Record<AgentType, TypeAvailability>>;

export const INITIAL_AVAILABILITY: TypeAvailability = {
  autoEnable: true,
  off: [],
  replacement: null,
  release: null,
};

export const modelAvailabilityAtom = atomWithLocalStorage<ModelAvailability>(
  "dispatch:preview:model-availability",
  {}
);

/** Claude's versionless ids follow the newest model in their family. */
export function followsLatest(
  type: AgentType,
  id: string,
  state: TypeAvailability
): boolean {
  if (type !== "claude" || /\d/.test(id)) return false;
  return !(id === "opus" && state.release === "held");
}

/** The catalog as it would read after the simulated release. */
export function previewModels(
  type: AgentType,
  models: readonly Model[],
  release: TypeAvailability["release"]
): (Model & { isNew?: boolean })[] {
  if (!release) return [...models];
  if (type === "codex")
    return [
      { id: "gpt-6.3-sol", label: "GPT-6.3 Sol", isNew: true },
      ...models,
    ];
  if (type !== "claude") return [...models];
  return models.flatMap((model) => {
    if (model.id !== "opus") return [model];
    return release === "followed"
      ? [
          { ...model, label: "Opus 5.6", isNew: true },
          { ...model, id: "claude-opus-5-5" },
        ]
      : [
          { ...model, id: "claude-opus-5-6", label: "Opus 5.6", isNew: true },
          model,
        ];
  });
}

export function simulateRelease(
  type: AgentType,
  state: TypeAvailability
): TypeAvailability {
  const { autoEnable, off } = state;
  const found = type === "codex" ? "gpt-6.3-sol" : "claude-opus-5-6";
  // An opt-out belongs to the version, so it moves when the alias moves on.
  const carried =
    type === "claude" && autoEnable
      ? off.map((id) => (id === "opus" ? "claude-opus-5-5" : id))
      : off;
  return {
    ...state,
    release: autoEnable ? "followed" : "held",
    off: autoEnable ? carried : [...carried, found],
  };
}
