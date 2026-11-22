import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Danger has to read as text on every surface it lands on, in every theme.
const css = readFileSync(resolve(__dirname, "../index.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  ""
);

type Vars = Record<string, string>;
const root: Vars = {};
const themes: Record<string, Vars> = {};
for (const [, head = "", body = ""] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  const selectors = (head.split(";").pop() ?? "")
    .split(",")
    .map((selector) => selector.trim());
  const vars: Vars = {};
  for (const [, name = "", value = ""] of body.matchAll(
    /--([\w-]+):\s*([^;]+);/g
  ))
    vars[name] = value.trim();
  if (selectors.includes(":root")) Object.assign(root, vars);
  for (const selector of selectors) {
    const name = /^\[data-theme="([^"]+)"\]$/.exec(selector)?.[1];
    if (name) themes[name] = { ...themes[name], ...vars };
  }
}

type Rgb = [number, number, number];

function rgb(hsl: string): Rgb {
  const [h = 0, s = 0, l = 0] = hsl
    .replaceAll("%", "")
    .split(/\s+/)
    .map(Number);
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
  const channel = (n: number) => {
    const k = (n + h / 30) % 12;
    return l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [channel(0), channel(8), channel(4)];
}

function mix(top: Rgb, below: Rgb, alpha: number): Rgb {
  return [
    top[0] * alpha + below[0] * (1 - alpha),
    top[1] * alpha + below[1] * (1 - alpha),
    top[2] * alpha + below[2] * (1 - alpha),
  ];
}

function luminance(colour: Rgb): number {
  const [r, g, b] = colour.map((v) =>
    v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  ) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: Rgb, b: Rgb): number {
  const [la, lb] = [luminance(a), luminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const all = { default: root, ...themes };

it("finds all twelve themes", () => {
  expect(Object.keys(all)).toHaveLength(12);
});

describe.each(Object.entries(all))("%s", (_theme, own) => {
  const vars = { ...root, ...own };
  const colour = (name: string) => rgb(vars[name] ?? "");
  const fill = colour("status-blocked");
  const surfaces = ["background", "card", "popover"].map(colour);

  it("reads danger text on surfaces, tints and hovers", () => {
    const text = colour("danger-ink");
    const behind = [
      ...surfaces,
      colour("muted"),
      // tint and tint-strong
      ...surfaces.flatMap((s) => [mix(fill, s, 0.1), mix(fill, s, 0.18)]),
    ];
    for (const surface of behind)
      expect(contrast(text, surface)).toBeGreaterThanOrEqual(4.5);
  });

  it("reads text on a solid danger fill, resting and hovered", () => {
    const text = colour("danger-foreground");
    // dense
    for (const behind of [fill, ...surfaces.map((s) => mix(fill, s, 0.92))])
      expect(contrast(text, behind)).toBeGreaterThanOrEqual(4.5);
  });
});
