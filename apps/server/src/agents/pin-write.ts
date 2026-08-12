import { randomUUID } from "node:crypto";

import {
  isPinType,
  validatePinShortcutFields,
  validatePinValue,
  type PinType,
} from "../pins.js";
import { AgentError } from "./errors.js";
import { finalizePin, mergePin, type DraftPin } from "./pin-merge.js";
import type { AgentPin } from "./types.js";

/**
 * Maximum number of pins per agent. Enforced by every write path here and by
 * `normalizeInitialPins` when seeding via `createAgent({ initialPins })`. Pins
 * also flow into the startup prompt via `buildStartupPrompt`, so the cap also
 * bounds prompt size.
 */
export const MAX_PINS = 50;

/**
 * A pin as an agent submits it.
 *
 * `type` and `value` are optional because an update that omits either
 * inherits the stored one. Defaulting `type` to "string" would make a pure
 * relabel silently demote a shortcut pin and drop its icon; requiring `value`
 * would make the same relabel restate the prompt it is not changing. Both are
 * required in effect when creating, enforced in `toStorablePin`.
 */
export type PinSpec = Omit<AgentPin, "type" | "value"> & {
  type?: PinType;
  value?: string;
};

/**
 * Validate the pin that is actually about to be stored, narrowing it.
 *
 * This runs after the merge rather than on the incoming spec, because the
 * effective type may come from the stored pin — validating the request alone
 * would check the value against the wrong type.
 */
function validateStoredPin(pin: DraftPin): AgentPin {
  if (!isPinType(pin.type)) {
    throw new AgentError(`Invalid pin type: ${pin.type}`, 400);
  }
  const stored: AgentPin = { ...pin, type: pin.type };
  try {
    validatePinValue(stored.type, stored.value);
    if (stored.type === "shortcut") validatePinShortcutFields(stored);
  } catch (error) {
    throw new AgentError(
      error instanceof Error ? error.message : String(error),
      400
    );
  }
  return stored;
}

/**
 * Resolve a spec against the pin it is updating, inheriting an omitted type or
 * value. With nothing to inherit from we are creating, and a pin with no value
 * has nothing to display — so that is the one case where value is mandatory.
 */
function toStorablePin(spec: PinSpec, existing?: AgentPin): DraftPin {
  const value = spec.value ?? existing?.value;
  if (value === undefined) {
    throw new AgentError("value is required when creating a pin.", 400);
  }
  return { ...spec, value, type: spec.type ?? existing?.type ?? "string" };
}

/** Case-insensitive label equality — the historical uniqueness rule. */
function sameLabel(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function sameGroup(pin: AgentPin, group: string): boolean {
  return (pin.group ?? "").trim().toLowerCase() === group.trim().toLowerCase();
}

/**
 * A blank group name matches every *ungrouped* pin, so accepting one would
 * turn "clear this group" into "delete everything without a heading". Group
 * targeting is the safety boundary for the destructive paths — it has to name
 * something.
 */
function assertNamedGroup(group: string): void {
  if (group.trim() === "") {
    throw new AgentError("A group name is required.", 400);
  }
}

/** Enforce case-insensitive label uniqueness across a finished pin array. */
function assertUniqueLabels(pins: AgentPin[]): void {
  const seen = new Set<string>();
  for (const pin of pins) {
    const key = pin.label.toLowerCase();
    if (seen.has(key)) {
      throw new AgentError(
        `Two pins would share the label "${pin.label}".`,
        400
      );
    }
    seen.add(key);
  }
}

/**
 * Locate the pin a spec addresses.
 *
 * `id` wins when present: it is the only handle that survives a relabel, so
 * matching it first is what makes renaming a patch rather than a delete and
 * recreate. An `id` that matches nothing is an error rather than a create —
 * a typo'd id should not quietly become a second pin alongside the one the
 * agent meant to edit.
 */
function findTarget(pins: AgentPin[], spec: PinSpec): number {
  if (spec.id !== undefined) {
    const index = pins.findIndex((pin) => pin.id === spec.id);
    if (index === -1) {
      throw new AgentError(`Pin not found: ${spec.id}`, 404);
    }
    return index;
  }
  return pins.findIndex((pin) => sameLabel(pin.label, spec.label));
}

/**
 * Labels are unique case-insensitively, and the sidebar leans on it. A rename
 * is the one write that can break the invariant, so it is checked against
 * every pin except the one being edited.
 */
function assertLabelFree(
  pins: AgentPin[],
  label: string,
  exceptIndex: number
): void {
  const clash = pins.findIndex(
    (pin, index) => index !== exceptIndex && sameLabel(pin.label, label)
  );
  if (clash !== -1) {
    throw new AgentError(`Another pin already uses the label "${label}".`, 400);
  }
}

export type ApplyPinResult = {
  pins: AgentPin[];
  stored: AgentPin;
  created: boolean;
};

/**
 * Apply one pin spec to the array, returning a new array.
 *
 * Position is deliberately stable on update: re-pinning to refresh a value
 * must not shuffle the sidebar out from under the user, and grouped pins
 * would tear apart if an update relocated a member.
 */
export function applyPinSpec(pins: AgentPin[], spec: PinSpec): ApplyPinResult {
  const index = findTarget(pins, spec);

  if (index !== -1) {
    assertLabelFree(pins, spec.label, index);
    const existing = pins[index]!;
    const stored = validateStoredPin(
      finalizePin(
        mergePin(
          { ...existing, id: existing.id ?? randomUUID() },
          toStorablePin(spec, existing)
        )
      )
    );
    const next = [...pins];
    next[index] = stored;
    return { pins: next, stored, created: false };
  }

  if (pins.length >= MAX_PINS) {
    throw new AgentError(`Maximum of ${MAX_PINS} pins reached.`, 400);
  }
  const stored = validateStoredPin(
    finalizePin({ ...toStorablePin(spec), id: spec.id ?? randomUUID() })
  );
  return { pins: [...pins, stored], stored, created: true };
}

/** Fold a batch of specs through {@link applyPinSpec}, in order. */
export function applyPinSpecs(
  pins: AgentPin[],
  specs: PinSpec[]
): { pins: AgentPin[]; stored: AgentPin[] } {
  let next = pins;
  const stored: AgentPin[] = [];
  for (const spec of specs) {
    const result = applyPinSpec(next, spec);
    next = result.pins;
    stored.push(result.stored);
  }
  return { pins: next, stored };
}

/**
 * Make `group` contain exactly `specs`, in the order given, without deleting
 * anything outside it.
 *
 * Specs resolve against the whole array (by id, then by label) so an existing
 * pin can be pulled into the group and keep its id and decorations; a pin the
 * agent names this way moves rather than being duplicated. Members of the
 * group that no spec claimed are dropped — that is the whole point of a
 * replace — but a pin outside the group is only ever moved by being named,
 * never removed.
 *
 * The rebuilt block sits where the group already started, so replacing a
 * group's contents does not make it jump position in the sidebar.
 */
export function replacePinGroup(
  pins: AgentPin[],
  group: string,
  specs: PinSpec[]
): { pins: AgentPin[]; stored: AgentPin[] } {
  assertNamedGroup(group);
  const claimed = new Set<number>();
  const stored: AgentPin[] = [];

  for (const rawSpec of specs) {
    // Filing members under the group is this function's own job — leaving it
    // to the caller means the primitive cannot honour its name, and a member
    // stored without `group` renders under no heading yet sits in the block,
    // invisible to the next replace of that same group.
    const spec: PinSpec = { ...rawSpec, group };
    const index = findTarget(pins, spec);
    if (index === -1) {
      stored.push(
        validateStoredPin(
          finalizePin({
            ...toStorablePin(spec),
            id: spec.id ?? randomUUID(),
          })
        )
      );
      continue;
    }
    if (claimed.has(index)) {
      throw new AgentError(
        `Two entries in the batch address the same pin "${pins[index]!.label}".`,
        400
      );
    }
    claimed.add(index);
    const existing = pins[index]!;
    stored.push(
      validateStoredPin(
        finalizePin(
          mergePin(
            { ...existing, id: existing.id ?? randomUUID() },
            toStorablePin(spec, existing)
          )
        )
      )
    );
  }

  // Anchor the block where the group already lived, so a replace does not
  // relocate it relative to ungrouped pins.
  const anchor = pins.findIndex((pin) => sameGroup(pin, group));
  const survivors = pins
    .map((pin, index) => ({ pin, index }))
    .filter(({ pin, index }) => !claimed.has(index) && !sameGroup(pin, group));

  const next: AgentPin[] = [];
  let inserted = false;
  for (const { pin, index } of survivors) {
    if (!inserted && anchor !== -1 && index > anchor) {
      next.push(...stored);
      inserted = true;
    }
    next.push(pin);
  }
  if (!inserted) next.push(...stored);

  // Each spec resolves against the *original* array, so two creates sharing a
  // new label would both look unmatched and slip through — check the finished
  // array instead. This also catches a create colliding with a survivor.
  assertUniqueLabels(next);

  if (next.length > MAX_PINS) {
    throw new AgentError(`Maximum of ${MAX_PINS} pins reached.`, 400);
  }
  return { pins: next, stored };
}

/** Remove pins by id. Every id must exist, so a typo surfaces rather than no-ops. */
export function removePinsByIds(pins: AgentPin[], ids: string[]): AgentPin[] {
  const wanted = new Set(ids);
  const missing = ids.filter((id) => !pins.some((pin) => pin.id === id));
  if (missing.length > 0) {
    throw new AgentError(`Pin not found: ${missing.join(", ")}`, 404);
  }
  return pins.filter((pin) => !wanted.has(pin.id ?? ""));
}

/** Remove every pin in a group. A group with no members is a 404, matching delete-by-id. */
export function removePinGroup(pins: AgentPin[], group: string): AgentPin[] {
  assertNamedGroup(group);
  const next = pins.filter((pin) => !sameGroup(pin, group));
  if (next.length === pins.length) {
    throw new AgentError(`No pins in group "${group}".`, 404);
  }
  return next;
}
