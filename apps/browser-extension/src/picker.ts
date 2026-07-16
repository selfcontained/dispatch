import { buildSelector, createBrowserSelection } from "./lib/element-context";

declare global {
  interface Window {
    __dispatchElementPickerCleanup?: () => void;
  }
}

window.__dispatchElementPickerCleanup?.();

const overlay = document.createElement("div");
overlay.setAttribute("data-dispatch-picker-overlay", "");
Object.assign(overlay.style, {
  position: "fixed",
  zIndex: "2147483647",
  pointerEvents: "none",
  border: "2px solid #7c3aed",
  background: "rgba(124, 58, 237, 0.12)",
  borderRadius: "3px",
  boxSizing: "border-box",
  display: "none",
});
document.documentElement.append(overlay);

const selectorBadge = document.createElement("div");
selectorBadge.setAttribute("data-dispatch-picker-label", "");
Object.assign(selectorBadge.style, {
  position: "fixed",
  zIndex: "2147483647",
  pointerEvents: "none",
  display: "none",
  maxWidth: "min(560px, calc(100vw - 16px))",
  overflow: "hidden",
  padding: "5px 8px",
  borderRadius: "4px",
  color: "#ffffff",
  background: "#6d28d9",
  boxShadow: "0 2px 8px rgba(0, 0, 0, 0.35)",
  font: "12px/1.35 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
});
document.documentElement.append(selectorBadge);

let hovered: Element | null = null;

function cleanup(): void {
  document.removeEventListener("mousemove", handleMove, true);
  document.removeEventListener("click", handleClick, true);
  document.removeEventListener("keydown", handleKeydown, true);
  window.removeEventListener("scroll", handleViewportChange, true);
  window.removeEventListener("resize", handleViewportChange);
  overlay.remove();
  selectorBadge.remove();
  hovered = null;
  delete window.__dispatchElementPickerCleanup;
}

function positionPicker(target: Element, updateSelector: boolean): void {
  const rect = target.getBoundingClientRect();
  Object.assign(overlay.style, {
    display: "block",
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  });
  if (updateSelector) selectorBadge.textContent = buildSelector(target);
  Object.assign(selectorBadge.style, {
    display: "block",
    left: `${Math.max(8, Math.min(rect.left, window.innerWidth - 240))}px`,
    top: `${rect.top >= 34 ? rect.top - 30 : Math.min(window.innerHeight - 30, rect.bottom + 6)}px`,
  });
}

function handleMove(event: MouseEvent): void {
  const target = event.composedPath()[0];
  if (!(target instanceof Element) || target === overlay) return;
  const targetChanged = target !== hovered;
  hovered = target;
  positionPicker(target, targetChanged);
}

function handleViewportChange(): void {
  if (!hovered?.isConnected) return;
  positionPicker(hovered, false);
}

function handleClick(event: MouseEvent): void {
  if (!hovered) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  try {
    const selection = createBrowserSelection(hovered);
    cleanup();
    void chrome.runtime.sendMessage({
      type: "picker:selected",
      selection,
    });
  } catch {
    cleanup();
    void chrome.runtime.sendMessage({ type: "picker:failed" });
  }
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key !== "Escape") return;
  event.preventDefault();
  cleanup();
  void chrome.runtime.sendMessage({ type: "picker:cancelled" });
}

document.addEventListener("mousemove", handleMove, true);
document.addEventListener("click", handleClick, true);
document.addEventListener("keydown", handleKeydown, true);
window.addEventListener("scroll", handleViewportChange, true);
window.addEventListener("resize", handleViewportChange);
window.__dispatchElementPickerCleanup = cleanup;
