import { useCallback, useEffect, useState } from "react";

export type ThemeId = "default" | "crumbstream";

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
