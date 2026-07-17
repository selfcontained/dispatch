export const SELECTIONS_KEY = "dispatchAgentSelections";

export interface SelectionStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export function agentSelectionKey(baseUrl: string, origin: string): string {
  return `${baseUrl}|${origin}`;
}

export async function loadRememberedAgentId(
  storage: SelectionStorage,
  baseUrl: string,
  origin: string
): Promise<string | null> {
  const stored = await storage.get(SELECTIONS_KEY);
  const selections = (stored[SELECTIONS_KEY] ?? {}) as Record<string, string>;
  return selections[agentSelectionKey(baseUrl, origin)] ?? null;
}

export async function rememberAgentSelection(
  storage: SelectionStorage,
  baseUrl: string,
  origin: string,
  agentId: string
): Promise<void> {
  const stored = await storage.get(SELECTIONS_KEY);
  const selections = (stored[SELECTIONS_KEY] ?? {}) as Record<string, string>;
  selections[agentSelectionKey(baseUrl, origin)] = agentId;
  await storage.set({ [SELECTIONS_KEY]: selections });
}
