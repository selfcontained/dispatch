import type { AgentPin } from "../agents/types.js";

/**
 * The agent-facing shape of a pin. One declared projection governs both what
 * `dispatch_list_pins` returns and what `dispatch_pin` echoes back, so the two
 * tools speak the same vocabulary and internal bookkeeping fields added to
 * `AgentPin` never leak into tool output by accident.
 */
export type PinListing = {
  id: string;
  label: string;
  value: string;
  type: string;
  caption?: string;
  group?: string;
  icon?: string;
  variant?: string;
  confirm?: boolean;
};

export function toPinListing(pin: AgentPin): PinListing {
  if (!pin.id) throw new Error("Pin is missing its stable ID.");
  return {
    id: pin.id,
    label: pin.label,
    value: pin.value,
    type: pin.type,
    ...(pin.caption !== undefined ? { caption: pin.caption } : {}),
    ...(pin.group !== undefined ? { group: pin.group } : {}),
    ...(pin.icon !== undefined ? { icon: pin.icon } : {}),
    ...(pin.variant !== undefined ? { variant: pin.variant } : {}),
    ...(pin.confirm !== undefined ? { confirm: pin.confirm } : {}),
  };
}
