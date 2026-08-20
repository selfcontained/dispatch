import { useEffect, useMemo, useState } from "react";

export type MermaidRenderTheme = {
  darkMode: boolean;
  fontFamily: string;
  themeVariables: Record<string, string | boolean>;
};

function hslToken(name: string, styles: CSSStyleDeclaration): string {
  return `hsl(${styles.getPropertyValue(name).trim()})`;
}

function parseHslChannels(color: string): [number, number, number] | null {
  const match = color.match(
    /^hsl\(\s*(-?\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%\s*\)$/i
  );
  if (!match) return null;
  return [
    Number(match[1]) % 360,
    Number(match[2]) / 100,
    Number(match[3]) / 100,
  ];
}

function lightnessFromHsl(color: string): number | null {
  return parseHslChannels(color)?.[2] ?? null;
}

export function useMermaidTheme(): MermaidRenderTheme | null {
  const [themeVersion, setThemeVersion] = useState(0);

  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      setThemeVersion((version) => version + 1);
    });

    observer.observe(root, {
      attributes: true,
      attributeFilter: ["data-theme", "style", "class"],
    });

    return () => observer.disconnect();
  }, []);

  return useMemo(() => {
    void themeVersion;
    if (typeof window === "undefined") return null;

    const styles = window.getComputedStyle(document.documentElement);
    const background = hslToken("--background", styles);
    const foreground = hslToken("--foreground", styles);
    const primary = hslToken("--primary", styles);
    const primaryForeground = hslToken("--primary-foreground", styles);
    const muted = hslToken("--muted", styles);
    const mutedForeground = hslToken("--muted-foreground", styles);
    const border = hslToken("--border", styles);
    const card = hslToken("--card", styles);
    const cardForeground = hslToken("--card-foreground", styles);
    const destructive = hslToken("--destructive", styles);
    const destructiveForeground = hslToken("--destructive-foreground", styles);
    const fontFamily =
      styles.getPropertyValue("--font-terminal").trim() ||
      "system-ui, sans-serif";

    const lightness = lightnessFromHsl(background);
    const darkMode = lightness === null ? true : lightness < 0.5;

    return {
      darkMode,
      fontFamily,
      themeVariables: {
        darkMode,
        background,
        mainBkg: card,
        secondBkg: muted,
        tertiaryColor: muted,
        primaryColor: primary,
        primaryTextColor: primaryForeground,
        primaryBorderColor: border,
        secondaryColor: muted,
        secondaryTextColor: foreground,
        secondaryBorderColor: border,
        tertiaryTextColor: mutedForeground,
        tertiaryBorderColor: border,
        lineColor: mutedForeground,
        textColor: foreground,
        nodeTextColor: cardForeground,
        clusterBkg: background,
        clusterBorder: border,
        defaultLinkColor: mutedForeground,
        titleColor: foreground,
        edgeLabelBackground: background,
        labelBackground: background,
        actorBkg: card,
        actorBorder: border,
        actorTextColor: foreground,
        actorLineColor: mutedForeground,
        signalColor: mutedForeground,
        signalTextColor: foreground,
        c0: card,
        c1: muted,
        c2: background,
        errorBkgColor: destructive,
        errorTextColor: destructiveForeground,
      },
    };
  }, [themeVersion]);
}
