import { agentChangesRoute, agentRoute } from "@/lib/agent-routes";

/**
 * The center-pane tabs. **Agent** is the Chat feed at `/agents/:id`;
 * Changes has a route of its own.
 */
export type CenterTab = "agent" | "changes";

/**
 * Ids older builds persisted: round 1/2's "chat" tab and the "terminal" tab
 * that hosted the Console. Stored values carrying them are folded into the
 * Agent pane by `normalizeSplitPaneState`.
 */
export type LegacyCenterTab = CenterTab | "chat" | "terminal";

export type CenterTabDef = {
  id: CenterTab;
  label: string;
  route: (agentId: string) => string;
};

/**
 * The center-pane tabs, in display order. One registry so the tab bar, the
 * routing hook, the split-pane headers and the persisted-tab validation all
 * agree on which tabs exist and what they are called.
 */
export const CENTER_TABS: readonly CenterTabDef[] = [
  { id: "agent", label: "Agent", route: agentRoute },
  { id: "changes", label: "Changes", route: agentChangesRoute },
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

export function centerTabRoute(agentId: string, tab: CenterTab): string {
  return centerTabDef(tab).route(agentId);
}

/** Stored values are user-editable localStorage; anything unknown reads as unset. */
export function isCenterTab(value: unknown): value is CenterTab {
  return typeof value === "string" && BY_ID.has(value as CenterTab);
}

/** `isCenterTab`, plus the retired ids stored state may still carry. */
export function isLegacyCenterTab(value: unknown): value is LegacyCenterTab {
  return value === "chat" || value === "terminal" || isCenterTab(value);
}
