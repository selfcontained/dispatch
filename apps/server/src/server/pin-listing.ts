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
  disabled?: boolean;
};

/**
 * The identity-and-position view of a pin, for echoing back a bulk write.
 * Deliberately omits `value` and the decorations: a batch of 50 pins would
 * otherwise return tens of KB to say what order things ended up in.
 */
export type PinSummary = {
  id: string;
  label: string;
  group?: string;
};

export function toPinSummary(pin: AgentPin): PinSummary {
  if (!pin.id) throw new Error("Pin is missing its stable ID.");
  return {
    id: pin.id,
    label: pin.label,
    ...(pin.group !== undefined ? { group: pin.group } : {}),
  };
}

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
    ...(pin.disabled !== undefined ? { disabled: pin.disabled } : {}),
  };
}
