import type { Agent } from "@/components/app/types";

import type { Step } from "./contracts";
import { shortcutLabelsFromSteps } from "./registry";
import { ShortcutRow } from "./shortcut-row";

/**
 * The shortcut pins a turn's steps wrote, in their live state from the
 * agent record: a pin since deleted is gone here too. Nothing when the
 * turn pinned none.
 */
export function TurnShortcuts({
  agent,
  agentId,
  steps,
}: {
  agent: Agent | null;
  agentId: string | null;
  steps: Step[];
}): JSX.Element | null {
  const labels = shortcutLabelsFromSteps(steps);
  if (labels.length === 0 || !agentId) return null;
  const live = (agent?.pins ?? []).filter(
    (pin) => pin.type === "shortcut" && labels.includes(pin.label)
  );
  if (live.length === 0) return null;
  return (
    <ShortcutRow
      agentId={agentId}
      agentName={agent?.name ?? null}
      agentRunning={agent?.status === "running"}
      pins={live}
    />
  );
}
