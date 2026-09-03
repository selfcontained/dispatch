import { type CenterTab } from "@/lib/store";

/**
 * The last center tab the user picked for an agent, remembered so the bare
 * `/agents/:id` route can land on Chat by default without trapping someone
 * who deliberately switched to the Console. Plain localStorage rather than an
 * atom: nothing renders from it — only the routing hook reads it, once, when
 * it decides whether to redirect.
 */
const PREFIX = "dispatch:centerTab:";

const TABS: readonly CenterTab[] = [
  "chat",
  "terminal",
  "changes",
  "whiteboard",
];

export function readLastCenterTab(agentId: string): CenterTab | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(`${PREFIX}${agentId}`);
    return raw && (TABS as readonly string[]).includes(raw)
      ? (raw as CenterTab)
      : null;
  } catch {
    return null;
  }
}

export function rememberCenterTab(agentId: string, tab: CenterTab): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(`${PREFIX}${agentId}`, tab);
  } catch {
    // Storage full or unavailable — the default just wins next time.
  }
}
