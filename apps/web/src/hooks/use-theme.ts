import { useCallback, useEffect, useState } from "react";

export type ThemeId = "default" | "cool-navy" | "oled-black" | "solarized-dark" | "light" | "vaporwave" | "matrix" | "midnight";

export type TerminalPalette = {
  minimumContrastRatio?: number;
  foreground: string;
  background: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  selectionInactiveBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
};

export type ThemeDefinition = {
  id: ThemeId;
  label: string;
  description: string;
  swatches: string[];
  terminal: TerminalPalette;
};

/** Monokai — used by Warm Dark, Cool Navy, OLED Black */
const MONOKAI: TerminalPalette = {
  foreground: "#f8f8f2",
  background: "#141414",
  cursor: "#f8f8f0",
  cursorAccent: "#141414",
  selectionBackground: "#49483e",
  selectionInactiveBackground: "#3e3d32",
  black: "#141414",
  red: "#f92672",
  green: "#a6e22e",
  yellow: "#f4bf75",
  blue: "#66d9ef",
  magenta: "#ae81ff",
  cyan: "#a1efe4",
  white: "#f8f8f2",
  brightBlack: "#75715e",
  brightRed: "#f92672",
  brightGreen: "#a6e22e",
  brightYellow: "#f4bf75",
  brightBlue: "#66d9ef",
  brightMagenta: "#ae81ff",
  brightCyan: "#a1efe4",
  brightWhite: "#f9f8f5",
};

const SOLARIZED_DARK: TerminalPalette = {
  foreground: "#839496",
  background: "#002b36",
  cursor: "#839496",
  cursorAccent: "#002b36",
  selectionBackground: "#073642",
  selectionInactiveBackground: "#073642",
  black: "#073642",
  red: "#dc322f",
  green: "#859900",
  yellow: "#b58900",
  blue: "#268bd2",
  magenta: "#d33682",
  cyan: "#2aa198",
  white: "#eee8d5",
  brightBlack: "#586e75",
  brightRed: "#cb4b16",
  brightGreen: "#586e75",
  brightYellow: "#657b83",
  brightBlue: "#839496",
  brightMagenta: "#6c71c4",
  brightCyan: "#93a1a1",
  brightWhite: "#fdf6e3",
};

const LIGHT: TerminalPalette = {
  minimumContrastRatio: 4.5,
  foreground: "#1f2328",
  background: "#eff2f5",
  cursor: "#1f2328",
  cursorAccent: "#eff2f5",
  selectionBackground: "#d1d9e0",
  selectionInactiveBackground: "#dae0e7",
  black: "#1f2328",
  red: "#c7243a",
  green: "#2a7e4f",
  yellow: "#9a6700",
  blue: "#0842a0",
  magenta: "#8b3fc7",
  cyan: "#0f7b8a",
  white: "#59636e",
  brightBlack: "#818b98",
  brightRed: "#b91c33",
  brightGreen: "#1a6b3c",
  brightYellow: "#8a5d00",
  brightBlue: "#0842a0",
  brightMagenta: "#7132a8",
  brightCyan: "#0b6674",
  brightWhite: "#393f46",
};

/** Vaporwave — neon pink, cyan & purple on deep purple-black */
const VAPORWAVE: TerminalPalette = {
  foreground: "#e0d0f0",
  background: "#110720",
  cursor: "#ff71ce",
  cursorAccent: "#110720",
  selectionBackground: "#2e1450",
  selectionInactiveBackground: "#241040",
  black: "#110720",
  red: "#ff71ce",
  green: "#05ffa1",
  yellow: "#fffb96",
  blue: "#01cdfe",
  magenta: "#b967ff",
  cyan: "#01cdfe",
  white: "#e0d0f0",
  brightBlack: "#6a5a8a",
  brightRed: "#ff9ade",
  brightGreen: "#50ffbe",
  brightYellow: "#fffcb5",
  brightBlue: "#50dfff",
  brightMagenta: "#d094ff",
  brightCyan: "#50dfff",
  brightWhite: "#f0e4ff",
};

/** Matrix — restrained phosphor green on deep black */
const MATRIX: TerminalPalette = {
  minimumContrastRatio: 4.5,
  foreground: "#b7ffc9",
  background: "#020403",
  cursor: "#6bff8f",
  cursorAccent: "#020403",
  selectionBackground: "#174d28",
  selectionInactiveBackground: "#102d1a",
  black: "#020403",
  red: "#a63a3a",
  green: "#1fa34a",
  yellow: "#c6a94a",
  blue: "#3fbf7f",
  magenta: "#5bd47f",
  cyan: "#7ceea3",
  white: "#b7ffc9",
  brightBlack: "#3d5b45",
  brightRed: "#cf6666",
  brightGreen: "#6bff8f",
  brightYellow: "#e4cf7d",
  brightBlue: "#6ff0ab",
  brightMagenta: "#97ffb6",
  brightCyan: "#c8ffda",
  brightWhite: "#effff2",
};

export const THEMES: ThemeDefinition[] = [
  {
    id: "cool-navy",
    label: "Cool Navy",
    description: "Cool navy with cyan & pink accents",
    swatches: ["#0e1014", "#58b8ff", "#ff5db1", "#f1e84f"],
    terminal: { ...MONOKAI, background: "#0e1014", cursorAccent: "#0e1014", black: "#0e1014" },
  },
  {
    id: "light",
    label: "Light",
    description: "Primer-inspired IDE light theme",
    swatches: ["#e6eaef", "#0d7d4d", "#1f2328", "#d1d9e0"],
    terminal: LIGHT,
  },
  {
    id: "matrix",
    label: "Matrix",
    description: "Phosphor green on near-black terminal glass",
    swatches: ["#020403", "#0a0f0b", "#1fa34a", "#6bff8f"],
    terminal: MATRIX,
  },
  {
    id: "midnight",
    label: "Midnight",
    description: "OLED black with vibrant cyan & pink",
    swatches: ["#000000", "#58b8ff", "#ff5db1", "#f1e84f"],
    terminal: { ...MONOKAI, background: "#000000", cursorAccent: "#000000", black: "#000000" },
  },
  {
    id: "oled-black",
    label: "OLED Black",
    description: "True black for OLED screens",
    swatches: ["#000000", "#34d399", "#f0f0f0", "#222222"],
    terminal: { ...MONOKAI, background: "#000000", cursorAccent: "#000000", black: "#000000" },
  },
  {
    id: "solarized-dark",
    label: "Solarized Dark",
    description: "Classic Ethan Schoonover palette",
    swatches: ["#002b36", "#268bd2", "#859900", "#b58900"],
    terminal: SOLARIZED_DARK,
  },
  {
    id: "vaporwave",
    label: "Vaporwave",
    description: "Neon pink & cyan on deep purple",
    swatches: ["#1a0a2e", "#ff71ce", "#01cdfe", "#b967ff"],
    terminal: VAPORWAVE,
  },
  {
    id: "default",
    label: "Warm Dark",
    description: "Warm charcoal with emerald accents",
    swatches: ["#141210", "#0d8358", "#f5f0f0", "#4d3e2e"],
    terminal: MONOKAI,
  },
];

export function getTerminalPalette(themeId: ThemeId): TerminalPalette {
  return THEMES.find((t) => t.id === themeId)?.terminal ?? MONOKAI;
}

const STORAGE_KEY = "dispatch:theme";

function getStoredTheme(): ThemeId {
  if (typeof window === "undefined") return "cool-navy";
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored && THEMES.some((t) => t.id === stored)) return stored as ThemeId;
  return "cool-navy";
}

function applyTheme(themeId: ThemeId): void {
  const root = document.documentElement;
  if (themeId === "default") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", themeId);
  }
}

export function useTheme(): {
  theme: ThemeId;
  setTheme: (id: ThemeId) => void;
} {
  const [theme, setThemeState] = useState<ThemeId>(getStoredTheme);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const setTheme = useCallback((id: ThemeId) => {
    window.localStorage.setItem(STORAGE_KEY, id);
    setThemeState(id);
  }, []);

  return { theme, setTheme };
}
