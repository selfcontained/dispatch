import { HOTKEYS, type HotkeyId } from "./keymap";

const IS_MAC =
  typeof navigator !== "undefined"
    ? /Mac|iPod|iPhone|iPad/.test(navigator.platform)
    : false;

const TOKEN_DISPLAY_MAC: Record<string, string> = {
  mod: "⌘",
  cmd: "⌘",
  meta: "⌘",
  ctrl: "⌃",
  shift: "⇧",
  alt: "⌥",
  option: "⌥",
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
  esc: "Esc",
  enter: "↵",
  return: "↵",
  space: "Space",
};

const TOKEN_DISPLAY_OTHER: Record<string, string> = {
  mod: "Ctrl",
  cmd: "Ctrl",
  meta: "Win",
  ctrl: "Ctrl",
  shift: "Shift",
  alt: "Alt",
  option: "Alt",
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
  esc: "Esc",
  enter: "Enter",
  return: "Enter",
  space: "Space",
};

function displayToken(token: string): string {
  const map = IS_MAC ? TOKEN_DISPLAY_MAC : TOKEN_DISPLAY_OTHER;
  return map[token] ?? token.toUpperCase();
}

export function formatCombo(combo: string): string {
  const parts = formatComboParts(combo);
  return IS_MAC ? parts.join("") : parts.join("+");
}

export function formatComboParts(combo: string): string[] {
  return combo
    .toLowerCase()
    .split("+")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(displayToken);
}

export function formatHotkey(id: HotkeyId): string {
  return formatCombo(HOTKEYS[id].combo);
}

export function formatHotkeyParts(id: HotkeyId): string[] {
  return formatComboParts(HOTKEYS[id].combo);
}

/**
 * Splits a hotkey into a modifier cluster and the trigger key, ready for a
 * kbd-style display like `⌘⇧ + >`.
 *
 * On macOS modifier glyphs are joined tight (e.g. "⌘⇧"); on other platforms
 * they're "+" joined ("Ctrl+Shift") since the names need a separator.
 */
export function formatHotkeyForKbd(id: HotkeyId): {
  modifiers: string | null;
  key: string;
} {
  const parts = formatComboParts(HOTKEYS[id].combo);
  if (parts.length === 0) return { modifiers: null, key: "" };
  if (parts.length === 1) return { modifiers: null, key: parts[0] };
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  return {
    modifiers: IS_MAC ? mods.join("") : mods.join("+"),
    key,
  };
}
