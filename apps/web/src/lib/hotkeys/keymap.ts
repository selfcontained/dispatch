// Single source of truth for app-level keyboard shortcuts.
//
// Each hotkey has a stable id so handlers reference the binding indirectly —
// the combo can change in one place without touching wiring.
//
// Combo grammar: "+"-separated tokens, case-insensitive. Recognized tokens:
//   mod    → Cmd on macOS, Ctrl elsewhere (use this for cross-platform)
//   ctrl   → Ctrl key (literal, both platforms)
//   shift, alt (a.k.a. option), meta (a.k.a. cmd)
//   any other token is the key (matched against KeyboardEvent.key, lowercased)
//
// Shifted symbol keys (e.g. ">", "<") are matched on KeyboardEvent.key, so
// the binding works across keyboard layouts where the physical position of
// the symbol differs.
//
// Hotkeys fire from anywhere in the page, including text inputs and the
// terminal. To suppress firing inside a particular subtree (e.g. an open
// modal that owns its own keyboard shortcuts), mark that subtree's root
// with `data-hotkey-disable="true"`.

export type HotkeyDef = {
  combo: string;
  description: string;
};

export const HOTKEYS = {
  "toggle-media-sidebar": {
    combo: "mod+shift+>",
    description: "Toggle media sidebar",
  },
  "toggle-agent-sidebar": {
    combo: "mod+shift+<",
    description: "Toggle agent sidebar",
  },
  "focus-prev-agent": {
    combo: "mod+shift+up",
    description: "Focus previous agent",
  },
  "focus-next-agent": {
    combo: "mod+shift+down",
    description: "Focus next agent",
  },
  "open-command-palette": {
    combo: "mod+k",
    description: "Open command palette",
  },
} satisfies Record<string, HotkeyDef>;

export type HotkeyId = keyof typeof HOTKEYS;
