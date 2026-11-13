import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * PopoverContent, DropdownMenuContent and SelectContent cap themselves at the
 * height Radix measures between the anchor and the (safe-area padded)
 * viewport edge. A caller's own `max-h-*` class replaces that cap through
 * tailwind-merge, so a fixed value like `max-h-72` lets a menu that flipped
 * upward run off the top of the screen (Create Agent's project picker did).
 * Any override has to keep the available-height variable, e.g.
 * `max-h-[min(18rem,var(--radix-dropdown-menu-content-available-height))]`.
 */
const SRC = join(__dirname, "..", "..");
const OVERLAY_TAG = /<(PopoverContent|DropdownMenuContent|SelectContent)\b/g;
const AVAILABLE_HEIGHT =
  /--radix-(popover-content|dropdown-menu-content|select-content|popper)-available-height/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) ? [path] : [];
  });
}

/** The opening tag's props, up to the matching `>` at brace depth zero. */
function openingTag(source: string, start: number): string {
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === ">" && depth === 0 && source[i - 1] !== "=") {
      return source.slice(start, i);
    }
  }
  return source.slice(start);
}

describe("overlay height caps", () => {
  it("keeps Radix's available height in every caller max-h override", () => {
    const offenders: string[] = [];
    let checked = 0;
    for (const file of sourceFiles(SRC)) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(OVERLAY_TAG)) {
        checked++;
        const tag = openingTag(source, match.index);
        const caps = tag.match(/(?<![\w-])max-h-(\[[^\]]*\]|[\w./-]+)/g) ?? [];
        for (const cap of caps) {
          if (!AVAILABLE_HEIGHT.test(cap)) {
            const line = source.slice(0, match.index).split("\n").length;
            offenders.push(`${relative(SRC, file)}:${line} ${match[1]} ${cap}`);
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(20);
    expect(offenders).toEqual([]);
  });
});
