import { describe, expect, it } from "vitest";

import type { AgentPin } from "../src/agents/types.js";
import {
  applyPinSpec,
  applyPinSpecs,
  removePinGroup,
  removePinsByIds,
  replacePinGroup,
} from "../src/agents/pin-write.js";

function pin(over: Partial<AgentPin> & { label: string }): AgentPin {
  return { value: "v", type: "string", ...over };
}

// applyPinSpec accepts a spec whose type may be omitted; the helper above
// always sets one, so these tests pass raw objects where inheritance matters.

const existing: AgentPin[] = [
  pin({ id: "pin_a", label: "Alpha", group: "Build" }),
  pin({ id: "pin_b", label: "Bravo", group: "Build" }),
  pin({ id: "pin_c", label: "Charlie" }),
];

describe("applyPinSpec", () => {
  it("updates in place when the label already exists", () => {
    const result = applyPinSpec(existing, pin({ label: "alpha", value: "2" }));
    expect(result.created).toBe(false);
    expect(result.pins.map((p) => p.id)).toEqual(["pin_a", "pin_b", "pin_c"]);
    expect(result.pins[0]!.value).toBe("2");
    // The group it already had survives an update that did not mention it.
    expect(result.pins[0]!.group).toBe("Build");
  });

  it("appends an unknown label", () => {
    const result = applyPinSpec(existing, pin({ label: "Delta" }));
    expect(result.created).toBe(true);
    expect(result.pins).toHaveLength(4);
    expect(result.pins[3]!.id).toBeTruthy();
  });

  it("renames when addressed by id, keeping position and decorations", () => {
    // The whole point of id matching: the label is free to change because it
    // is no longer what identifies the pin.
    const result = applyPinSpec(
      existing,
      pin({ id: "pin_a", label: "Renamed" })
    );
    expect(result.created).toBe(false);
    expect(result.pins[0]).toMatchObject({
      id: "pin_a",
      label: "Renamed",
      group: "Build",
    });
    expect(result.pins).toHaveLength(3);
  });

  it("rejects an id that matches nothing rather than creating a stray pin", () => {
    expect(() =>
      applyPinSpec(existing, pin({ id: "pin_zz", label: "Ghost" }))
    ).toThrow(/not found/i);
  });

  it("rejects a rename onto another pin's label", () => {
    // Case-insensitive label uniqueness is load-bearing for the sidebar.
    expect(() =>
      applyPinSpec(existing, pin({ id: "pin_a", label: "bravo" }))
    ).toThrow(/already uses the label/i);
  });

  it("allows a no-op relabel of the pin onto its own label", () => {
    expect(() =>
      applyPinSpec(existing, pin({ id: "pin_a", label: "ALPHA" }))
    ).not.toThrow();
  });

  it("inherits the stored type when an update omits it", () => {
    // Defaulting an omitted type to "string" would make a pure relabel demote
    // a shortcut to a plain string and strip its icon — the exact operation
    // this whole id-matching path exists to make cheap.
    const shortcuts: AgentPin[] = [
      {
        id: "pin_s",
        label: "Run it",
        value: "do the thing",
        type: "shortcut",
        icon: "zap",
        variant: "primary",
      },
    ];
    const result = applyPinSpec(shortcuts, {
      id: "pin_s",
      label: "Run it now",
      value: "do the thing",
    });
    expect(result.stored).toMatchObject({
      type: "shortcut",
      icon: "zap",
      variant: "primary",
      label: "Run it now",
    });
  });

  it("defaults a brand new pin with no type to string", () => {
    const result = applyPinSpec([], { label: "Fresh", value: "v" });
    expect(result.stored.type).toBe("string");
  });

  it("still strips shortcut-only fields when a pin is retyped", () => {
    const shortcuts: AgentPin[] = [
      {
        id: "pin_s",
        label: "Run it",
        value: "do the thing",
        type: "shortcut",
        icon: "zap",
      },
    ];
    const result = applyPinSpec(shortcuts, {
      id: "pin_s",
      label: "Run it",
      value: "do the thing",
      type: "string",
    });
    expect(result.stored.icon).toBeUndefined();
  });

  it("validates the value against the inherited type, not the request", () => {
    const urls: AgentPin[] = [
      { id: "pin_u", label: "Docs", value: "https://x.dev", type: "url" },
    ];
    expect(() =>
      applyPinSpec(urls, { id: "pin_u", label: "Docs", value: "not a url" })
    ).toThrow();
  });
});

describe("applyPinSpecs", () => {
  it("applies a batch in order and reports each stored pin", () => {
    const result = applyPinSpecs(existing, [
      pin({ id: "pin_a", label: "A2" }),
      pin({ label: "Delta" }),
    ]);
    expect(result.pins.map((p) => p.label)).toEqual([
      "A2",
      "Bravo",
      "Charlie",
      "Delta",
    ]);
    expect(result.stored).toHaveLength(2);
  });

  it("leaves pins the batch did not mention alone", () => {
    const result = applyPinSpecs(existing, [pin({ label: "Delta" })]);
    expect(result.pins.map((p) => p.id)).toContain("pin_c");
  });
});

describe("replacePinGroup", () => {
  it("makes the group exactly the given pins, in order", () => {
    const result = replacePinGroup(existing, "Build", [
      pin({ id: "pin_b", label: "Bravo", group: "Build" }),
      pin({ label: "Echo", group: "Build" }),
    ]);
    expect(result.pins.map((p) => p.label)).toEqual([
      "Bravo",
      "Echo",
      "Charlie",
    ]);
  });

  it("drops group members the batch omitted", () => {
    const result = replacePinGroup(existing, "Build", [
      pin({ id: "pin_b", label: "Bravo", group: "Build" }),
    ]);
    expect(result.pins.some((p) => p.id === "pin_a")).toBe(false);
  });

  it("never removes a pin outside the group", () => {
    // The entire safety argument for replace mode: naming a group bounds the
    // blast radius, so an ungrouped pin set hours ago cannot be collateral.
    const result = replacePinGroup(existing, "Build", []);
    expect(result.pins.map((p) => p.id)).toEqual(["pin_c"]);
  });

  it("anchors the rebuilt group where it already sat", () => {
    const pins = [
      pin({ id: "pin_top", label: "Top" }),
      pin({ id: "pin_g1", label: "G1", group: "Build" }),
      pin({ id: "pin_end", label: "End" }),
    ];
    const result = replacePinGroup(pins, "Build", [
      pin({ label: "Fresh", group: "Build" }),
    ]);
    expect(result.pins.map((p) => p.label)).toEqual(["Top", "Fresh", "End"]);
  });

  it("appends a group that does not exist yet", () => {
    const result = replacePinGroup(existing, "New", [
      pin({ label: "Foxtrot", group: "New" }),
    ]);
    expect(result.pins.map((p) => p.label)).toEqual([
      "Alpha",
      "Bravo",
      "Charlie",
      "Foxtrot",
    ]);
  });

  it("moves a named pin into the group instead of duplicating it", () => {
    const result = replacePinGroup(existing, "Build", [
      pin({ id: "pin_c", label: "Charlie", group: "Build" }),
    ]);
    expect(result.pins.map((p) => p.id)).toEqual(["pin_c"]);
    expect(result.pins[0]!.group).toBe("Build");
  });

  it("rejects two new entries that would share a label", () => {
    // Each spec resolves against the original array, so two creates sharing a
    // label both look unmatched — the uniqueness check has to run on the
    // finished array, not per spec.
    expect(() =>
      replacePinGroup(existing, "Build", [
        pin({ label: "Duplicate", group: "Build" }),
        pin({ label: "duplicate", group: "Build" }),
      ])
    ).toThrow(/share the label/i);
  });

  it("treats a label matching an outside pin as a move, not a duplicate", () => {
    // Label matching resolves against the whole array, so naming an existing
    // pin pulls it into the group rather than creating a second one with the
    // same label — which is also why this can't break label uniqueness.
    const result = replacePinGroup(existing, "Build", [
      pin({ label: "charlie", group: "Build" }),
    ]);
    expect(result.pins.map((p) => p.id)).toEqual(["pin_c"]);
    expect(result.pins[0]!.group).toBe("Build");
  });

  it("refuses a blank group rather than treating it as 'ungrouped'", () => {
    expect(() => replacePinGroup(existing, "   ", [])).toThrow(
      /group name is required/i
    );
  });

  it("rejects two entries addressing the same pin", () => {
    expect(() =>
      replacePinGroup(existing, "Build", [
        pin({ id: "pin_a", label: "One", group: "Build" }),
        pin({ id: "pin_a", label: "Two", group: "Build" }),
      ])
    ).toThrow(/same pin/i);
  });
});

describe("removePinsByIds", () => {
  it("removes every listed id", () => {
    expect(removePinsByIds(existing, ["pin_a", "pin_c"])).toHaveLength(1);
  });

  it("rejects an unknown id rather than silently no-opping", () => {
    expect(() => removePinsByIds(existing, ["pin_a", "nope"])).toThrow(
      /not found/i
    );
  });
});

describe("removePinGroup", () => {
  it("removes every member of the group", () => {
    expect(removePinGroup(existing, "Build").map((p) => p.id)).toEqual([
      "pin_c",
    ]);
  });

  it("matches the group name case-insensitively", () => {
    expect(removePinGroup(existing, "build")).toHaveLength(1);
  });

  it("rejects an empty group", () => {
    expect(() => removePinGroup(existing, "Nothing")).toThrow(/no pins/i);
  });

  it("refuses a blank group name instead of deleting every ungrouped pin", () => {
    // sameGroup() treats a missing group as "", so a blank name would match
    // every ungrouped pin and quietly turn this into a mass delete.
    for (const blank of ["", "   "]) {
      expect(() => removePinGroup(existing, blank)).toThrow(
        /group name is required/i
      );
    }
    // The ungrouped pin is still there.
    expect(existing.some((p) => p.id === "pin_c")).toBe(true);
  });
});
