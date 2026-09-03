import {
  agentChangesRoute,
  agentRoute,
  agentWhiteboardRoute,
} from "@/lib/agent-routes";

/**
 * With the chat surface on, the terminal's tab becomes the **Agent** pane:
 * one tab hosting both the Chat feed and the Console (the terminal), flipped
 * with a toggle in the pane header rather than a route. With it off, the tab
 * is the plain **Terminal** it always was. Both live at `/agents/:id`; only
 * one of the two ids is ever offered at a time.
 */
export type CenterTab = "agent" | "terminal" | "changes" | "whiteboard";

/**
 * Round 1/2 persisted a "chat" tab id (its own route at the time). It is no
 * longer a tab; stored values are folded into the Agent pane by
 * `normalizeSplitPaneState`.
 */
export type LegacyCenterTab = CenterTab | "chat";

export type CenterTabDef = {
  id: CenterTab;
  label: string;
  route: (agentId: string) => string;
  /** Whether the tab is offered at all under this flag value. */
  available: (chatEnabled: boolean) => boolean;
};

/**
 * The center-pane tabs, in display order. One registry so the tab bar, the
 * routing hook, the split-pane headers and the persisted-tab validation all
 * agree on which tabs exist and what they are called.
 */
export const CENTER_TABS: readonly CenterTabDef[] = [
  {
    id: "agent",
    label: "Agent",
    route: agentRoute,
    available: (chatEnabled) => chatEnabled,
  },
  {
    id: "terminal",
    label: "Terminal",
    route: agentRoute,
    available: (chatEnabled) => !chatEnabled,
  },
  {
    id: "changes",
    label: "Changes",
    route: agentChangesRoute,
    available: () => true,
  },
  {
    id: "whiteboard",
    label: "Whiteboard",
    route: agentWhiteboardRoute,
    available: () => true,
  },
];

const BY_ID: ReadonlyMap<CenterTab, CenterTabDef> = new Map(
  CENTER_TABS.map((tab) => [tab.id, tab])
);

export function centerTabDef(tab: CenterTab): CenterTabDef {
  const def = BY_ID.get(tab);
  if (!def) throw new Error(`Unknown center tab: ${tab}`);
  return def;
}

export function centerTabLabel(tab: CenterTab): string {
  return centerTabDef(tab).label;
}

/** The tabs offered under this flag value, in display order. */
export function centerTabs(chatEnabled: boolean): CenterTabDef[] {
  return CENTER_TABS.filter((tab) => tab.available(chatEnabled));
}

export function centerTabRoute(agentId: string, tab: CenterTab): string {
  return centerTabDef(tab).route(agentId);
}

/** The id the terminal-hosting tab goes by under this flag value. */
export function terminalHostTab(chatEnabled: boolean): CenterTab {
  return chatEnabled ? "agent" : "terminal";
}

/** Stored values are user-editable localStorage; anything unknown reads as unset. */
export function isCenterTab(value: unknown): value is CenterTab {
  return typeof value === "string" && BY_ID.has(value as CenterTab);
}
