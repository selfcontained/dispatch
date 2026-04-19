/**
 * Handler factory for a Radix Dialog `onEscapeKeyDown` prop that prevents
 * the dialog from closing when the Escape key originated inside a nested
 * cmdk combobox (e.g. `BranchSelect`). The combobox handles its own
 * Escape via its React `onKeyDown`, so the dialog must stay put.
 *
 * Usage:
 *   <DialogContent onEscapeKeyDown={swallowEscapeFromCombobox}>…</DialogContent>
 *
 * Consumers that need additional escape logic can call this first and
 * branch on `event.defaultPrevented`.
 */
export function swallowEscapeFromCombobox(event: KeyboardEvent): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.closest("[cmdk-root]")) {
    event.preventDefault();
  }
}
