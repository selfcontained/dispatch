import {
  agentChangesRoute,
  agentChatRoute,
  agentRoute,
  agentWhiteboardRoute,
} from "@/lib/agent-routes";

export type CenterTab = "chat" | "terminal" | "changes" | "whiteboard";

export type CenterTabDef = {
  id: CenterTab;
  /**
   * Labels depend on the chat surface flag: with it on the terminal is
   * demoted to a lower-level "Console" behind the Chat tab; with it off the
   * labels are exactly what they were before the flag existed.
   */
  label: (chatEnabled: boolean) => string;
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
    id: "chat",
    label: () => "Chat",
    route: agentChatRoute,
    available: (chatEnabled) => chatEnabled,
  },
  {
    id: "terminal",
    label: (chatEnabled) => (chatEnabled ? "Console" : "Terminal"),
    route: agentRoute,
    available: () => true,
  },
  {
    id: "changes",
    label: () => "Changes",
    route: agentChangesRoute,
    available: () => true,
  },
  {
    id: "whiteboard",
    label: () => "Whiteboard",
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

export function centerTabLabel(tab: CenterTab, chatEnabled: boolean): string {
  return centerTabDef(tab).label(chatEnabled);
}

/** The tabs offered under this flag value, in display order. */
export function centerTabs(chatEnabled: boolean): CenterTabDef[] {
  return CENTER_TABS.filter((tab) => tab.available(chatEnabled));
}

export function centerTabRoute(agentId: string, tab: CenterTab): string {
  return centerTabDef(tab).route(agentId);
}

/** Stored values are user-editable localStorage; anything unknown reads as unset. */
export function isCenterTab(value: unknown): value is CenterTab {
  return typeof value === "string" && BY_ID.has(value as CenterTab);
}
