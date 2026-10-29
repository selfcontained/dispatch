/** Pins only partition the supplied cards; hidden or stale IDs never add cards. */
export function pinnedFirst<T extends { id: string }>(
  cards: readonly T[],
  pins: ReadonlySet<string>
): T[] {
  return [
    ...cards.filter((card) => pins.has(card.id)),
    ...cards.filter((card) => !pins.has(card.id)),
  ];
}

export function isSidebarPinPreference(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((id) => typeof id === "string");
}

export function toggleSidebarPin(
  pins: readonly string[],
  id: string
): string[] {
  const next = new Set(pins.filter((pin) => pin.trim().length > 0));
  if (next.has(id)) next.delete(id);
  else if (id.trim()) next.add(id);
  return [...next];
}

/** Reorder visible members of one pin group in their existing normal-order slots.
 * Other groups and filtered-out sessions keep their normal positions.
 */
export function reorderSidebarPinGroup(
  normalOrder: readonly string[],
  visibleIds: readonly string[],
  pins: ReadonlySet<string>,
  draggedId: string,
  targetId: string,
  position: "before" | "after"
): string[] {
  const visible = new Set(visibleIds);
  if (
    draggedId === targetId ||
    !visible.has(draggedId) ||
    !visible.has(targetId) ||
    pins.has(draggedId) !== pins.has(targetId)
  )
    return [...normalOrder];
  const group = normalOrder.filter(
    (id) => visible.has(id) && pins.has(id) === pins.has(draggedId)
  );
  const next = group.filter((id) => id !== draggedId);
  const targetIndex = next.indexOf(targetId);
  if (!group.includes(draggedId) || targetIndex === -1) return [...normalOrder];
  next.splice(targetIndex + (position === "after" ? 1 : 0), 0, draggedId);
  const members = new Set(group);
  let index = 0;
  return normalOrder.map((id) => (members.has(id) ? next[index++] : id));
}
