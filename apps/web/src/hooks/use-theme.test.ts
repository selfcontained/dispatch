import { describe, expect, it } from "vitest";

import { THEMES, getTerminalPalette } from "@/hooks/use-theme";

/**
 * Rough perceived brightness (0 = black, 1 = white) of a #rrggbb hex — a
 * direct sRGB-channel weighting, not gamma-linearized WCAG relative luminance.
 * Good enough to classify a palette as light vs dark.
 */
function luminance(hex: string): number {
  const value = hex.replace("#", "");
  const r = parseInt(value.slice(0, 2), 16) / 255;
  const g = parseInt(value.slice(2, 4), 16) / 255;
  const b = parseInt(value.slice(4, 6), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

describe("terminal palettes track their theme mode", () => {
  // Regression guard for #813: the "light" theme shipped wired to the dark
  // MONOKAI palette, so its terminal stayed dark. Every light-mode theme must
  // pair with a light terminal background, and every dark-mode theme a dark one.
  for (const theme of THEMES) {
    it(`${theme.id} (${theme.mode}) has a ${theme.mode} terminal background`, () => {
      const bg = luminance(theme.terminal.background);
      if (theme.mode === "light") {
        expect(bg).toBeGreaterThan(0.5);
      } else {
        expect(bg).toBeLessThan(0.5);
      }
    });
  }

  it("getTerminalPalette('light') is a light palette, not MONOKAI", () => {
    const palette = getTerminalPalette("light");
    expect(luminance(palette.background)).toBeGreaterThan(0.5);
    expect(luminance(palette.foreground)).toBeLessThan(0.5);
  });
});
