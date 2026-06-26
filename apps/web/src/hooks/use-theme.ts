import { useCallback, useEffect, useState } from "react";

export type ThemeId =
  | "default"
  | "cool-navy"
  | "oled-black"
  | "solarized-dark"
  | "solarized-light"
  | "catppuccin-mocha"
  | "daylight"
  | "light"
  | "vaporwave"
  | "matrix"
  | "midnight"
  | "mytra";

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
  mode: "light" | "dark";
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

/** Solarized Light — warm cream paper with the canonical Solarized accents */
const SOLARIZED_LIGHT: TerminalPalette = {
  minimumContrastRatio: 4.5,
  foreground: "#586e75",
  background: "#fdf6e3",
  cursor: "#586e75",
  cursorAccent: "#fdf6e3",
  selectionBackground: "#eee8d5",
  selectionInactiveBackground: "#eee8d5",
  black: "#073642",
  red: "#dc322f",
  green: "#859900",
  yellow: "#b58900",
  blue: "#268bd2",
  magenta: "#d33682",
  cyan: "#2aa198",
  white: "#eee8d5",
  brightBlack: "#002b36",
  brightRed: "#cb4b16",
  brightGreen: "#586e75",
  brightYellow: "#657b83",
  brightBlue: "#839496",
  brightMagenta: "#6c71c4",
  brightCyan: "#93a1a1",
  brightWhite: "#fdf6e3",
};

/** Catppuccin Mocha — muted pastel palette on a soft dark base */
const CATPPUCCIN_MOCHA: TerminalPalette = {
  foreground: "#cdd6f4",
  background: "#1e1e2e",
  cursor: "#f5e0dc",
  cursorAccent: "#1e1e2e",
  selectionBackground: "#585b70",
  selectionInactiveBackground: "#45475a",
  black: "#45475a",
  red: "#f38ba8",
  green: "#a6e3a1",
  yellow: "#f9e2af",
  blue: "#89b4fa",
  magenta: "#f5c2e7",
  cyan: "#94e2d5",
  white: "#bac2de",
  brightBlack: "#585b70",
  brightRed: "#f38ba8",
  brightGreen: "#a6e3a1",
  brightYellow: "#f9e2af",
  brightBlue: "#89b4fa",
  brightMagenta: "#f5c2e7",
  brightCyan: "#94e2d5",
  brightWhite: "#a6adc8",
};

/** Daylight — high-contrast pure white tuned for outdoor / sunlit screens */
const DAYLIGHT: TerminalPalette = {
  minimumContrastRatio: 7,
  foreground: "#0a0c10",
  background: "#ffffff",
  cursor: "#0a0c10",
  cursorAccent: "#ffffff",
  selectionBackground: "#c4d4ff",
  selectionInactiveBackground: "#d8def0",
  black: "#0a0c10",
  red: "#c8102e",
  green: "#0d7d4d",
  yellow: "#a14400",
  blue: "#0050d8",
  magenta: "#8a1a8c",
  cyan: "#006d77",
  white: "#1f2328",
  brightBlack: "#5a6171",
  brightRed: "#b00020",
  brightGreen: "#0a6840",
  brightYellow: "#8a3700",
  brightBlue: "#003ea3",
  brightMagenta: "#6e0e80",
  brightCyan: "#005159",
  brightWhite: "#0a0c10",
};

/** Mytra — matte black, machined steel, and indigo-violet light */
const MYTRA: TerminalPalette = {
  minimumContrastRatio: 4.5,
  foreground: "#d9dde4",
  background: "#020202",
  cursor: "#6c63ff",
  cursorAccent: "#020202",
  selectionBackground: "#1e2232",
  selectionInactiveBackground: "#151821",
  black: "#020202",
  red: "#c96b72",
  green: "#7ca2a0",
  yellow: "#b6bec9",
  blue: "#6c63ff",
  magenta: "#8b73ff",
  cyan: "#9ea6ff",
  white: "#d9dde4",
  brightBlack: "#4f5662",
  brightRed: "#e08b92",
  brightGreen: "#95bcba",
  brightYellow: "#c8d0da",
  brightBlue: "#948cff",
  brightMagenta: "#ac97ff",
  brightCyan: "#c1c7ff",
  brightWhite: "#f3f6fb",
};

export const THEMES: ThemeDefinition[] = [
  {
    id: "catppuccin-mocha",
    label: "Catppuccin Mocha",
    description: "Muted pastel mauve & blue on a soft dark base",
    mode: "dark",
    swatches: ["#1e1e2e", "#cba6f7", "#89b4fa", "#f5c2e7"],
    terminal: CATPPUCCIN_MOCHA,
  },
  {
    id: "cool-navy",
    label: "Cool Navy",
    description: "Cool navy with cyan & pink accents",
    mode: "dark",
    swatches: ["#0e1014", "#58b8ff", "#ff5db1", "#f1e84f"],
    terminal: {
      ...MONOKAI,
      background: "#0e1014",
      cursorAccent: "#0e1014",
      black: "#0e1014",
    },
  },
  {
    id: "daylight",
    label: "Daylight",
    description: "High-contrast bright theme tuned for outdoor screens",
    mode: "light",
    swatches: ["#ffffff", "#0050d8", "#c8102e", "#0d7d4d"],
    terminal: DAYLIGHT,
  },
  {
    id: "light",
    label: "Light",
    description: "Primer-inspired IDE light theme",
    mode: "light",
    swatches: ["#e6eaef", "#0d7d4d", "#1f2328", "#d1d9e0"],
    terminal: MONOKAI,
  },
  {
    id: "matrix",
    label: "Matrix",
    description: "Phosphor green on near-black terminal glass",
    mode: "dark",
    swatches: ["#020403", "#0a0f0b", "#1fa34a", "#6bff8f"],
    terminal: MATRIX,
  },
  {
    id: "midnight",
    label: "Midnight",
    description: "OLED black with vibrant cyan & pink",
    mode: "dark",
    swatches: ["#000000", "#58b8ff", "#ff5db1", "#f1e84f"],
    terminal: {
      ...MONOKAI,
      background: "#000000",
      cursorAccent: "#000000",
      black: "#000000",
    },
  },
  {
    id: "mytra",
    label: "Mytra",
    description: "Matte black with machined steel and indigo-violet light",
    mode: "dark",
    swatches: ["#020202", "#20242c", "#5c6778", "#6c63ff"],
    terminal: MYTRA,
  },
  {
    id: "oled-black",
    label: "OLED Black",
    description: "True black for OLED screens",
    mode: "dark",
    swatches: ["#000000", "#34d399", "#f0f0f0", "#222222"],
    terminal: {
      ...MONOKAI,
      background: "#000000",
      cursorAccent: "#000000",
      black: "#000000",
    },
  },
  {
    id: "solarized-dark",
    label: "Solarized Dark",
    description: "Classic Ethan Schoonover palette",
    mode: "dark",
    swatches: ["#002b36", "#268bd2", "#859900", "#b58900"],
    terminal: SOLARIZED_DARK,
  },
  {
    id: "solarized-light",
    label: "Solarized Light",
    description: "Warm cream paper, restrained accents",
    mode: "light",
    swatches: ["#fdf6e3", "#268bd2", "#cb4b16", "#859900"],
    terminal: SOLARIZED_LIGHT,
  },
  {
    id: "vaporwave",
    label: "Vaporwave",
    description: "Neon pink & cyan on deep purple",
    mode: "dark",
    swatches: ["#1a0a2e", "#ff71ce", "#01cdfe", "#b967ff"],
    terminal: VAPORWAVE,
  },
  {
    id: "default",
    label: "Warm Dark",
    description: "Warm charcoal with emerald accents",
    mode: "dark",
    swatches: ["#141210", "#0d8358", "#f5f0f0", "#4d3e2e"],
    terminal: MONOKAI,
  },
];

export const DEFAULT_THEME_ID: ThemeId = "cool-navy";

export function getTerminalPalette(themeId: ThemeId): TerminalPalette {
  return THEMES.find((t) => t.id === themeId)?.terminal ?? MONOKAI;
}

const STORAGE_KEY = "dispatch:theme";

function getStoredTheme(): ThemeId {
  if (typeof window === "undefined") return DEFAULT_THEME_ID;
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored && THEMES.some((t) => t.id === stored)) return stored as ThemeId;
  return DEFAULT_THEME_ID;
}

function applyTheme(themeId: ThemeId): void {
  const root = document.documentElement;
  if (themeId === "default") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", themeId);
  }
  const mode = THEMES.find((t) => t.id === themeId)?.mode ?? "dark";
  root.setAttribute("data-theme-mode", mode);
  // The pre-paint script in index.html sets inline body bg/color and the
  // theme-color meta to avoid FOUC. After data-theme changes we re-derive
  // those from the live CSS tokens so the shell tracks the selected theme
  // (otherwise the body keeps the bg of whatever theme was active at load).
  const styles = window.getComputedStyle(root);
  const background = styles.getPropertyValue("--background").trim();
  const foreground = styles.getPropertyValue("--foreground").trim();
  if (background) {
    const bg = `hsl(${background})`;
    root.style.backgroundColor = bg;
    document.body.style.backgroundColor = bg;
    const metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) metaTheme.setAttribute("content", bg);
  }
  if (foreground) {
    document.body.style.color = `hsl(${foreground})`;
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
