import { createContext, useContext, type ReactNode } from "react";

import type { Agent } from "@/components/app/types";

/**
 * What a turn entry needs about its agent that `FeedContext` does not carry.
 * `FeedContext` is what every memoized feed row is keyed on, so it holds
 * only what changes rarely; the live agent record (its pins, its status)
 * changes on its own schedule, so it travels here and re-renders only the
 * turn entries, the way `PinShortcutContext` already does for pin rows.
 */
export type TurnContextValue = {
  /** The live agent record; its shortcut pins render under a turn's result. */
  agent: Agent | null;
};

/** The default: a turn renders without shortcut pins and asks for nothing. */
export const INERT_TURN_CONTEXT: TurnContextValue = { agent: null };

export const TurnContext = createContext<TurnContextValue>(INERT_TURN_CONTEXT);

export function TurnContextProvider({
  value,
  children,
}: {
  value: TurnContextValue;
  children: ReactNode;
}): JSX.Element {
  return <TurnContext.Provider value={value}>{children}</TurnContext.Provider>;
}

export function useTurnContext(): TurnContextValue {
  return useContext(TurnContext);
}
