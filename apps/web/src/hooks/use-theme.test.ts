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

/** Gamma-linearized sRGB channel, per the WCAG relative-luminance definition. */
function srgbChannel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance (0 = black, 1 = white) of a #rrggbb hex. */
function wcagLuminance(hex: string): number {
  const value = hex.replace("#", "");
  return (
    0.2126 * srgbChannel(parseInt(value.slice(0, 2), 16)) +
    0.7152 * srgbChannel(parseInt(value.slice(2, 4), 16)) +
    0.0722 * srgbChannel(parseInt(value.slice(4, 6), 16))
  );
}

/** WCAG contrast ratio between two #rrggbb hex colors (1:1 … 21:1). */
function contrastRatio(a: string, b: string): number {
  const la = wcagLuminance(a);
  const lb = wcagLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

describe("PRIMER_LIGHT renders legibly without leaning on the contrast clamp", () => {
  const palette = getTerminalPalette("light");
  const bg = palette.background;
  const ansi = [
    "foreground",
    "black",
    "red",
    "green",
    "yellow",
    "blue",
    "magenta",
    "cyan",
    "white",
    "brightBlack",
    "brightRed",
    "brightGreen",
    "brightYellow",
    "brightBlue",
    "brightMagenta",
    "brightCyan",
    "brightWhite",
  ] as const;

  // Regression guard for review #827 (item #161): every ANSI color must natively
  // clear 4.5:1 on the light bg, so xterm's minimumContrastRatio clamp never has
  // to silently remap Primer's values (which also collapsed the brights together).
  for (const key of ansi) {
    it(`${key} clears 4.5:1 against the background`, () => {
      expect(contrastRatio(palette[key], bg)).toBeGreaterThanOrEqual(4.5);
    });
  }

  // Regression guard for review #827 (item #162): on a light bg, "bright" white
  // must read stronger than normal white — i.e. darker / higher contrast.
  it("brightWhite is higher-contrast than white", () => {
    expect(contrastRatio(palette.brightWhite, bg)).toBeGreaterThan(
      contrastRatio(palette.white, bg)
    );
  });
});
