import { GitPullRequest, Trash2, Zap } from "lucide-react";
import { describe, expect, it } from "vitest";

import { resolvePinShortcutIcon } from "./pin-shortcut-icons";

/**
 * The name allowlist itself is pinned by the server-side lockstep test
 * (apps/server/test/pin-shortcut-icons-lockstep.test.ts), which compares this
 * module's keys against the dispatch_pin schema. What is left uncovered — and
 * what this file covers — is the resolution step: an agent supplies an
 * arbitrary string, and every path out of it has to yield a real component,
 * because the caller renders the result directly (`<Icon />`) with no guard.
 */
describe("resolvePinShortcutIcon", () => {
  it("resolves a name from the allowlist to its component", () => {
    expect(resolvePinShortcutIcon("trash")).toBe(Trash2);
  });

  it("resolves a hyphenated name", () => {
    expect(resolvePinShortcutIcon("pull-request")).toBe(GitPullRequest);
  });

  it("falls back to the zap glyph when no icon was set", () => {
    expect(resolvePinShortcutIcon(undefined)).toBe(Zap);
  });

  it("falls back for a name that is not on the allowlist", () => {
    expect(resolvePinShortcutIcon("nonexistent")).toBe(Zap);
  });

  it("falls back for an empty name rather than treating it as a lookup", () => {
    expect(resolvePinShortcutIcon("")).toBe(Zap);
  });

  // The lookup is an own-property check precisely so these fall through: `in`
  // or a bare `PIN_SHORTCUT_ICONS[name]` would hand the caller Object.prototype
  // members, which are not components and throw during render.
  it.each(["constructor", "__proto__", "toString", "hasOwnProperty"])(
    "falls back for the inherited key %j",
    (name) => {
      expect(resolvePinShortcutIcon(name)).toBe(Zap);
    }
  );
});
