import { useEffect, useRef } from "react";

import { HOTKEYS, type HotkeyDef, type HotkeyId } from "./keymap";

const IS_MAC =
  typeof navigator !== "undefined"
    ? /Mac|iPod|iPhone|iPad/.test(navigator.platform)
    : false;

type Parsed = {
  needMod: boolean;
  needCtrl: boolean;
  needShift: boolean;
  needAlt: boolean;
  needMeta: boolean;
  key: string;
};

// Aliases that map readable keymap tokens to the lowercased KeyboardEvent.key
// they should match. Unlisted tokens pass through unchanged.
const KEY_ALIASES: Record<string, string> = {
  up: "arrowup",
  down: "arrowdown",
  left: "arrowleft",
  right: "arrowright",
  esc: "escape",
  space: " ",
  enter: "enter",
  return: "enter",
};

function parseCombo(combo: string): Parsed {
  const parsed: Parsed = {
    needMod: false,
    needCtrl: false,
    needShift: false,
    needAlt: false,
    needMeta: false,
    key: "",
  };
  for (const raw of combo.toLowerCase().split("+")) {
    const token = raw.trim();
    if (!token) continue;
    if (token === "mod") parsed.needMod = true;
    else if (token === "ctrl") parsed.needCtrl = true;
    else if (token === "shift") parsed.needShift = true;
    else if (token === "alt" || token === "option") parsed.needAlt = true;
    else if (token === "meta" || token === "cmd") parsed.needMeta = true;
    else parsed.key = KEY_ALIASES[token] ?? token;
  }
  return parsed;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  if (target.closest('[data-hotkey-disable="true"]')) return true;
  return false;
}

// Browsers on macOS report the unshifted character for KeyboardEvent.key when
// Cmd is held (e.g. Cmd+Shift+. arrives as key=".", not ">"). To stay
// layout-flexible while supporting the common US-layout binding, we accept
// either the shifted symbol or its unshifted base when Shift is required.
const US_SHIFT_FALLBACK: Record<string, string> = {
  ">": ".",
  "<": ",",
  "?": "/",
  ":": ";",
  '"': "'",
  "{": "[",
  "}": "]",
  "|": "\\",
  "+": "=",
  _: "-",
  "(": "9",
  ")": "0",
  "!": "1",
  "@": "2",
  "#": "3",
  $: "4",
  "%": "5",
  "^": "6",
  "&": "7",
  "*": "8",
  "~": "`",
};

function comboMatches(parsed: Parsed, e: KeyboardEvent): boolean {
  const modPressed = IS_MAC ? e.metaKey : e.ctrlKey;
  if (parsed.needMod !== modPressed) return false;
  if (parsed.needShift !== e.shiftKey) return false;
  if (parsed.needAlt !== e.altKey) return false;
  if (parsed.needCtrl && !e.ctrlKey) return false;
  if (parsed.needMeta && !e.metaKey) return false;

  const eKey = e.key.toLowerCase();
  if (eKey === parsed.key) return true;
  if (parsed.needShift) {
    const unshifted = US_SHIFT_FALLBACK[parsed.key];
    if (unshifted && eKey === unshifted) return true;
  }
  return false;
}

export type UseHotkeyOptions = {
  enabled?: boolean;
};

/**
 * Bind a handler to a hotkey id from `keymap.ts`. Listener is registered at
 * the document level in capture phase, so it runs before nested handlers
 * (e.g. xterm.js inside the terminal).
 */
export function useHotkey(
  id: HotkeyId,
  handler: (e: KeyboardEvent) => void,
  options: UseHotkeyOptions = {}
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  const { enabled = true } = options;

  useEffect(() => {
    if (!enabled) return;
    const def: HotkeyDef = HOTKEYS[id];
    const parsed = parseCombo(def.combo);
    const allowInInputs = def.allowInInputs ?? false;

    const onKeyDown = (e: KeyboardEvent): void => {
      if (!comboMatches(parsed, e)) return;
      if (!allowInInputs && isEditableTarget(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      handlerRef.current(e);
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [id, enabled]);
}
