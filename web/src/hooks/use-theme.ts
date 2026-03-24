import { useCallback, useEffect, useState } from "react";

export type ThemeId = "default" | "crumbstream" | "oled-black" | "solarized-dark" | "light";

export type ThemeDefinition = {
  id: ThemeId;
  label: string;
  description: string;
  swatches: string[];
};

export const THEMES: ThemeDefinition[] = [
  {
    id: "default",
    label: "Warm Dark",
    description: "Warm charcoal with emerald accents",
    swatches: ["#141210", "#0d8358", "#f5f0f0", "#4d3e2e"],
  },
  {
    id: "crumbstream",
    label: "Cool Navy",
    description: "Cool navy with cyan & pink accents",
    swatches: ["#0e1014", "#58b8ff", "#ff5db1", "#f1e84f"],
  },
  {
    id: "oled-black",
    label: "OLED Black",
    description: "True black for OLED screens",
    swatches: ["#000000", "#34d399", "#f0f0f0", "#222222"],
  },
  {
    id: "solarized-dark",
    label: "Solarized Dark",
    description: "Classic Ethan Schoonover palette",
    swatches: ["#002b36", "#268bd2", "#859900", "#b58900"],
  },
  {
    id: "light",
    label: "Light",
    description: "Clean light theme for bright environments",
    swatches: ["#ffffff", "#0d7d4d", "#1a1a1a", "#e2e2e2"],
  },
];

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
