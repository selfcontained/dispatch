import { useCallback, useEffect, useState } from "react";

export type ThemeId = "default" | "crumbstream" | "oled-black" | "solarized-dark" | "light";

export type TerminalPalette = {
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
  foreground: "#1a1a1a",
  background: "#f5f5f4",
  cursor: "#1a1a1a",
  cursorAccent: "#f5f5f4",
  selectionBackground: "#d6d6d4",
  selectionInactiveBackground: "#e2e2e0",
  black: "#1a1a1a",
  red: "#c7243a",
  green: "#2a7e4f",
  yellow: "#9a6700",
  blue: "#0842a0",
  magenta: "#8b3fc7",
  cyan: "#0f7b8a",
  white: "#4b4b4b",
  brightBlack: "#555555",
  brightRed: "#b91c33",
  brightGreen: "#1a6b3c",
  brightYellow: "#8a5d00",
  brightBlue: "#0842a0",
  brightMagenta: "#7132a8",
  brightCyan: "#0b6674",
  brightWhite: "#333333",
};

export const THEMES: ThemeDefinition[] = [
  {
    id: "default",
    label: "Warm Dark",
    description: "Warm charcoal with emerald accents",
    swatches: ["#141210", "#0d8358", "#f5f0f0", "#4d3e2e"],
    terminal: MONOKAI,
  },
  {
    id: "crumbstream",
    label: "Cool Navy",
    description: "Cool navy with cyan & pink accents",
    swatches: ["#0e1014", "#58b8ff", "#ff5db1", "#f1e84f"],
    terminal: { ...MONOKAI, background: "#0e1014", cursorAccent: "#0e1014", black: "#0e1014" },
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
    id: "light",
    label: "Light",
    description: "Clean light theme for bright environments",
    swatches: ["#ffffff", "#0d7d4d", "#1a1a1a", "#e2e2e2"],
    terminal: LIGHT,
  },
];

export function getTerminalPalette(themeId: ThemeId): TerminalPalette {
  return THEMES.find((t) => t.id === themeId)?.terminal ?? MONOKAI;
}

const STORAGE_KEY = "dispatch:theme";

function getStoredTheme(): ThemeId {
  if (typeof window === "undefined") return "default";
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored && THEMES.some((t) => t.id === stored)) return stored as ThemeId;
  return "default";
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
