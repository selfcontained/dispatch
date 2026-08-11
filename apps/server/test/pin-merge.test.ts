import { describe, expect, it } from "vitest";

import { clearBlankPinFields, mergePin } from "../src/agents/pin-merge.js";
import type { AgentPin } from "../src/agents/types.js";

const existing: AgentPin = {
  id: "pin_1",
  label: "What day is it?",
  value: "What day is it today?",
  type: "shortcut",
  caption: "Day-related",
  icon: "clock",
  variant: "primary",
};

describe("mergePin", () => {
  // The real-world failure this guards: an agent re-pinned an existing
  // shortcut only to attach a group, and lost its icon, caption, and variant.
  it("keeps decorations the agent did not resend", () => {
    const merged = mergePin(existing, {
      label: "What day is it?",
      value: "What day is it today?",
      type: "shortcut",
      group: "Day quick actions",
    });

    expect(merged).toEqual({
      id: "pin_1",
      label: "What day is it?",
      value: "What day is it today?",
      type: "shortcut",
      caption: "Day-related",
      icon: "clock",
      variant: "primary",
      group: "Day quick actions",
    });
  });

  it("overwrites the fields the agent does resend", () => {
    const merged = mergePin(existing, {
      label: "What day is it?",
      value: "What is today's date?",
      type: "shortcut",
      icon: "calendar-ish",
      variant: "destructive",
    });

    expect(merged.value).toBe("What is today's date?");
    expect(merged.icon).toBe("calendar-ish");
    expect(merged.variant).toBe("destructive");
    expect(merged.caption).toBe("Day-related");
  });

  it("clears a decoration when the agent sends an empty string", () => {
    const merged = mergePin(existing, {
      label: "What day is it?",
      value: "What day is it today?",
      type: "shortcut",
      caption: "",
      icon: "   ",
    });

    expect(merged).not.toHaveProperty("caption");
    expect(merged).not.toHaveProperty("icon");
    expect(merged.variant).toBe("primary");
  });

  it("drops shortcut-only fields when the pin is re-typed", () => {
    // Omission means "keep", which would otherwise strand icon/variant/confirm
    // on a pin that can no longer use them.
    const merged = mergePin(
      { ...existing, confirm: true },
      { label: "What day is it?", value: "https://example.com", type: "url" }
    );

    expect(merged).not.toHaveProperty("icon");
    expect(merged).not.toHaveProperty("variant");
    expect(merged).not.toHaveProperty("confirm");
    expect(merged.caption).toBe("Day-related");
  });

  it("keeps the stored ID so the run endpoint stays addressable", () => {
    const merged = mergePin(existing, {
      id: "some-other-id",
      label: "What day is it?",
      value: "changed",
      type: "shortcut",
    });

    expect(merged.id).toBe("pin_1");
  });
});

describe("clearBlankPinFields", () => {
  it("leaves a pin without blank decorations untouched", () => {
    expect(clearBlankPinFields(existing)).toEqual(existing);
  });

  it("never strips label or value", () => {
    const cleared = clearBlankPinFields({
      label: "Empty",
      value: "",
      type: "string",
    });
    expect(cleared).toEqual({ label: "Empty", value: "", type: "string" });
  });
});
