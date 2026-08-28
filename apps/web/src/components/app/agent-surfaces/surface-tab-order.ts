/**
 * Pure ordering/visibility logic for the custom-tab strip, split out from
 * use-surface-tab-prefs.ts so it can be unit tested without React/jotai.
 */

/**
 * Layers the user's stored order on top of the server's canonical order:
 * previously-arranged tabs that still exist keep their relative order, and
 * any tab the user hasn't touched (new, or never reordered) is appended in
 * server order. Mirrors reconcileAgentSidebarOrder's merge shape in
 * lib/store.ts.
 */
export function mergeSurfaceTabOrder(
  serverIds: readonly string[],
  storedOrder: readonly string[]
): string[] {
  const serverSet = new Set(serverIds);
  const seen = new Set<string>();
  const result: string[] = [];

  for (const id of storedOrder) {
    if (!serverSet.has(id) || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }

  for (const id of serverIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }

  return result;
}

/** Swaps `id` with its neighbor in `order`. No-op at the array boundary. */
export function moveEarlier(order: readonly string[], id: string): string[] {
  const index = order.indexOf(id);
  if (index <= 0) return [...order];
  const next = [...order];
  [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
  return next;
}

export function moveLater(order: readonly string[], id: string): string[] {
  const index = order.indexOf(id);
  if (index === -1 || index >= order.length - 1) return [...order];
  const next = [...order];
  [next[index], next[index + 1]] = [next[index + 1]!, next[index]!];
  return next;
}
