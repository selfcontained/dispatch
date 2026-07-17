/**
 * Tap + refine target selection. A tap picks the initial element; the
 * refinement toolbar walks the target up to a parent or back down. Descending
 * retraces the exact path the user ascended (the trail) before falling back
 * to the first element child.
 */

export interface RefineState {
  current: Element;
  descendTrail: Element[];
}

function isOverlayElement(element: Element): boolean {
  return element.hasAttribute("data-dispatch-feedback-host");
}

export function createRefineState(target: Element): RefineState {
  return { current: target, descendTrail: [] };
}

export function canAscend(state: RefineState): boolean {
  const parent = state.current.parentElement;
  return parent !== null && parent.tagName !== "HTML";
}

export function canDescend(state: RefineState): boolean {
  const trailTop = state.descendTrail[state.descendTrail.length - 1];
  if (trailTop && trailTop.parentElement === state.current) return true;
  const child = state.current.firstElementChild;
  return child !== null && !isOverlayElement(child);
}

export function ascend(state: RefineState): RefineState {
  const parent = state.current.parentElement;
  if (!parent || parent.tagName === "HTML") return state;
  return {
    current: parent,
    descendTrail: [...state.descendTrail, state.current],
  };
}

export function descend(state: RefineState): RefineState {
  const trailTop = state.descendTrail[state.descendTrail.length - 1];
  if (trailTop && trailTop.parentElement === state.current) {
    return {
      current: trailTop,
      descendTrail: state.descendTrail.slice(0, -1),
    };
  }
  const child = state.current.firstElementChild;
  if (!child || isOverlayElement(child)) return state;
  return { current: child, descendTrail: [] };
}
