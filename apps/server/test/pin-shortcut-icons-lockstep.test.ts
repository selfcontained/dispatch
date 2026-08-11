import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { VALID_PIN_SHORTCUT_ICONS } from "../src/pins.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.."
);
const WEB_ICON_MODULE = path.join(
  repoRoot,
  "apps/web/src/lib/pin-shortcut-icons.ts"
);

/**
 * The server enumerates icon names for the dispatch_pin schema; the web maps
 * those names to components. They live in different packages with no shared
 * import path, so nothing but this test stops them drifting — and a drifted
 * name fails silently, rendering the fallback icon instead of the one the
 * agent asked for. Both files are pure data, which is what makes reading the
 * source acceptable here.
 */
function webIconNames(): string[] {
  const source = readFileSync(WEB_ICON_MODULE, "utf8");
  const start = source.indexOf("export const PIN_SHORTCUT_ICONS = {");
  expect(
    start,
    "PIN_SHORTCUT_ICONS not found in the web module"
  ).toBeGreaterThan(-1);
  const body = source.slice(
    start,
    source.indexOf("} as const satisfies", start)
  );
  return [...body.matchAll(/^\s+"?([a-z-]+)"?:\s/gm)].map((m) => m[1]!);
}

describe("shortcut icon allowlists", () => {
  it("match between the server schema and the web icon map", () => {
    expect(new Set(webIconNames())).toEqual(new Set(VALID_PIN_SHORTCUT_ICONS));
  });

  it("has no duplicates on the server side", () => {
    expect(new Set(VALID_PIN_SHORTCUT_ICONS).size).toBe(
      VALID_PIN_SHORTCUT_ICONS.length
    );
  });
});
