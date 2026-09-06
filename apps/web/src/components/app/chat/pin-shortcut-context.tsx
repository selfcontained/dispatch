import { createContext, useContext } from "react";

import { type AgentPin } from "@/components/app/types";

/**
 * What a pin shown in the feed needs from the pane: the live pins to
 * resolve against, and the shortcut machinery for the runnable ones.
 *
 * Kept out of `FeedContext` on purpose. Every row of the feed is memoised
 * on that context's identity, and these fields change on their own
 * schedule — a shortcut run flips `pendingPinId`, the agent stopping flips
 * `agentIsRunning`, a pin edit hands over a new `pins` — and only the rows
 * that show a pin care. As a context of their own they re-render those
 * rows and nothing else.
 */
export type PinShortcutState = {
  pins: AgentPin[];
  workspaceRoot: string | null;
  /** Off when the agent cannot receive a shortcut (stopped, archived). */
  agentIsRunning: boolean;
  /** The shortcut whose run is in flight; its button stays disabled. */
  pendingPinId: string | null;
  /**
   * Fires a shortcut pin shown in the feed, the same way the sidebar does.
   * Absent (agent history, tests) renders shortcuts inert.
   */
  onRunShortcut?: (pin: AgentPin, pointerType?: string) => void;
  /** Registers each shortcut button so the confirm dialog can hand focus back. */
  registerShortcutButton?: (
    pin: AgentPin,
    element: HTMLButtonElement | null
  ) => void;
};

/** No pane behind the feed: every pin reads as gone, shortcuts stay inert. */
export const INERT_PIN_SHORTCUTS: PinShortcutState = {
  pins: [],
  workspaceRoot: null,
  agentIsRunning: true,
  pendingPinId: null,
};

const PinShortcutContext = createContext<PinShortcutState>(INERT_PIN_SHORTCUTS);

export const PinShortcutProvider = PinShortcutContext.Provider;

export function usePinShortcuts(): PinShortcutState {
  return useContext(PinShortcutContext);
}
