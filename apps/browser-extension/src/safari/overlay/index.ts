import {
  buildSelector,
  createBrowserSelection,
} from "../../lib/element-context";
import { api } from "../../lib/extension-api";
import type {
  BrowserSelection,
  SafariRequest,
  WorkerRequest,
  WorkerResponse,
} from "../../types";
import { startAiming } from "./aim-layer";
import {
  ascend,
  canAscend,
  canDescend,
  createRefineState,
  descend,
  type RefineState,
} from "./refine";
import { mountCard, type CardHandle } from "./card";
import {
  bottomAnchoredTop,
  centeredLeft,
  clampToViewport,
  onViewportChange,
  readViewportMetrics,
} from "./viewport";

declare global {
  interface Window {
    __dispatchElementPickerCleanup?: () => void;
  }
}

window.__dispatchElementPickerCleanup?.();

const STYLES = `
:host {
  all: initial;
}
* {
  box-sizing: border-box;
}
.highlight {
  position: fixed;
  z-index: 1;
  pointer-events: none;
  border: 2px solid #7c3aed;
  background: rgba(124, 58, 237, 0.12);
  border-radius: 3px;
  display: none;
}
.badge {
  position: fixed;
  z-index: 2;
  pointer-events: none;
  display: none;
  max-width: min(560px, calc(100vw - 16px));
  overflow: hidden;
  padding: 5px 8px;
  border-radius: 4px;
  color: #ffffff;
  background: #6d28d9;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
  font: 12px/1.35 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hint,
.toolbar,
.card {
  position: fixed;
  z-index: 3;
  pointer-events: auto;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, sans-serif;
}
.hint {
  padding: 10px 16px;
  border-radius: 999px;
  background: #171717;
  color: #e7e5e4;
  font-size: 14px;
  font-weight: 600;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  border: 1px solid #44403c;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px;
  border-radius: 14px;
  background: #171717;
  border: 1px solid #44403c;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.45);
  max-width: calc(100vw - 16px);
}
.toolbar-selector {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 200px;
  color: #d6d3d1;
  font: 12px ui-monospace, SFMono-Regular, Menlo, monospace;
  padding: 0 4px;
}
.toolbar-button,
.card-button {
  min-height: 44px;
  min-width: 44px;
  padding: 8px 12px;
  border: 1px solid #44403c;
  border-radius: 10px;
  background: #262626;
  color: #e7e5e4;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}
.toolbar-button:disabled,
.card-button:disabled {
  opacity: 0.45;
  cursor: default;
}
.primary-button {
  border-color: #7c3aed;
  background: #7c3aed;
  color: #ffffff;
}
.subtle-button {
  min-height: 34px;
  padding: 4px 10px;
  font-size: 12px;
}
.card {
  display: grid;
  gap: 10px;
  width: min(560px, calc(100vw - 16px));
  max-height: 45vh;
  overflow-y: auto;
  padding: 14px;
  padding-bottom: calc(14px + env(safe-area-inset-bottom));
  border-radius: 16px;
  background: #171717;
  border: 1px solid #44403c;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
  color: #e7e5e4;
  font-size: 14px;
}
.card-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.card-selector {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #ddd6fe;
  font: 12px ui-monospace, SFMono-Regular, Menlo, monospace;
}
.card-form {
  display: grid;
  gap: 10px;
}
.card-label {
  display: grid;
  gap: 6px;
  color: #d6d3d1;
  font-size: 12px;
  font-weight: 600;
}
.card-select,
.card-textarea {
  width: 100%;
  padding: 10px;
  border: 1px solid #44403c;
  border-radius: 10px;
  background: #262626;
  color: #e7e5e4;
  font: inherit;
}
.card-textarea {
  min-height: 72px;
  resize: vertical;
}
.card-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.card-error {
  margin: 0;
  color: #fca5a5;
  font-size: 13px;
}
.card-note {
  margin: 0;
  color: #a8a29e;
}
.card-sent {
  margin: 0;
  text-align: center;
  font-size: 16px;
  font-weight: 700;
  color: #bbf7d0;
}
`;

class OverlayRequestError extends Error {
  constructor(
    message: string,
    readonly terminal: boolean
  ) {
    super(message);
  }
}

async function send<T>(request: WorkerRequest | SafariRequest): Promise<T> {
  const response = (await api.runtime.sendMessage(
    request
  )) as WorkerResponse<T>;
  if (!response?.ok) {
    throw new OverlayRequestError(
      response?.error ?? "Extension request failed.",
      response?.submissionTerminalFailure === true
    );
  }
  return response.data as T;
}

const host = document.createElement("div");
host.setAttribute("data-dispatch-feedback-host", "");
Object.assign(host.style, {
  position: "fixed",
  inset: "0",
  zIndex: "2147483647",
  pointerEvents: "none",
});
const shadow = host.attachShadow({ mode: "open" });
const styleElement = document.createElement("style");
styleElement.textContent = STYLES;

const highlight = document.createElement("div");
highlight.className = "highlight";
const badge = document.createElement("div");
badge.className = "badge";
const hint = document.createElement("div");
hint.className = "hint";
hint.textContent = "Tap an element to select it";
const toolbar = document.createElement("div");
toolbar.className = "toolbar";
toolbar.style.display = "none";
const cardContainer = document.createElement("div");
cardContainer.style.display = "none";

shadow.append(styleElement, highlight, badge, hint, toolbar, cardContainer);
document.documentElement.append(host);

let refine: RefineState | null = null;
let hoverTarget: Element | null = null;
let selection: BrowserSelection | null = null;
let card: CardHandle | null = null;
let stopAiming: (() => void) | null = null;
let stopViewportTracking: (() => void) | null = null;
let closed = false;

function displayedTarget(): Element | null {
  const target = refine?.current ?? hoverTarget;
  return target?.isConnected ? target : null;
}

function positionFloating(element: HTMLElement): void {
  const metrics = readViewportMetrics(window);
  const height = element.offsetHeight;
  const width = element.offsetWidth;
  element.style.top = `${bottomAnchoredTop(metrics, height, 16)}px`;
  element.style.left = `${centeredLeft(metrics, width)}px`;
}

function positionUI(): void {
  const target = displayedTarget();
  if (target) {
    const rect = target.getBoundingClientRect();
    Object.assign(highlight.style, {
      display: "block",
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
    const metrics = readViewportMetrics(window);
    badge.style.display = "block";
    const badgeTop =
      rect.top >= 34
        ? rect.top - 30
        : Math.min(rect.bottom + 6, metrics.offsetTop + metrics.height - 30);
    badge.style.left = `${clampToViewport(metrics, rect.left, Math.min(badge.offsetWidth, 240), "x")}px`;
    badge.style.top = `${badgeTop}px`;
  } else {
    highlight.style.display = "none";
    badge.style.display = "none";
  }
  if (hint.style.display !== "none") positionFloating(hint);
  if (toolbar.style.display !== "none") positionFloating(toolbar);
  if (cardContainer.style.display !== "none") positionFloating(cardContainer);
}

function renderToolbar(): void {
  if (!refine) {
    toolbar.style.display = "none";
    hint.style.display = "";
    positionUI();
    return;
  }
  hint.style.display = "none";
  toolbar.style.display = "flex";
  toolbar.replaceChildren();

  const selector = document.createElement("span");
  selector.className = "toolbar-selector";
  selector.textContent = buildSelector(refine.current);

  const parentButton = document.createElement("button");
  parentButton.type = "button";
  parentButton.className = "toolbar-button";
  parentButton.textContent = "‹ Parent";
  parentButton.disabled = !canAscend(refine);
  parentButton.addEventListener("click", () => {
    if (refine) refine = ascend(refine);
    renderToolbar();
  });

  const childButton = document.createElement("button");
  childButton.type = "button";
  childButton.className = "toolbar-button";
  childButton.textContent = "Child ›";
  childButton.disabled = !canDescend(refine);
  childButton.addEventListener("click", () => {
    if (refine) refine = descend(refine);
    renderToolbar();
  });

  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.className = "toolbar-button";
  cancelButton.textContent = "✕";
  cancelButton.setAttribute("aria-label", "Cancel selection");
  cancelButton.addEventListener("click", () => closeOverlay("cancelled"));

  const useButton = document.createElement("button");
  useButton.type = "button";
  useButton.className = "toolbar-button primary-button";
  useButton.textContent = "Use ✓";
  useButton.addEventListener("click", confirmSelection);

  toolbar.append(parentButton, childButton, selector, cancelButton, useButton);
  positionUI();
}

function beginAiming(): void {
  cardContainer.style.display = "none";
  card?.destroy();
  card = null;
  selection = null;
  stopAiming?.();
  stopAiming = startAiming(host, {
    onTargetCommitted(target) {
      hoverTarget = null;
      refine = createRefineState(target);
      renderToolbar();
    },
    onHover(target) {
      if (refine) return;
      hoverTarget = target;
      positionUI();
    },
    onCancel() {
      closeOverlay("cancelled");
    },
  });
  renderToolbar();
}

function confirmSelection(): void {
  if (!refine?.current.isConnected) return;
  try {
    selection = createBrowserSelection(refine.current);
  } catch {
    closeOverlay("failed");
    return;
  }
  stopAiming?.();
  stopAiming = null;
  hint.style.display = "none";
  toolbar.style.display = "none";
  badge.style.display = "none";
  cardContainer.style.display = "";
  card = mountCard(cardContainer, {
    send,
    origin: window.location.origin,
    selection,
    selectorLabel: buildSelector(refine.current),
    onReselect: beginAiming,
    onCancel: () => closeOverlay("cancelled"),
    onSubmitted: () => closeOverlay("submitted"),
  });
  positionUI();
}

function cleanup(): void {
  stopAiming?.();
  stopAiming = null;
  stopViewportTracking?.();
  stopViewportTracking = null;
  resizeObserver.disconnect();
  card?.destroy();
  card = null;
  refine = null;
  hoverTarget = null;
  host.remove();
  delete window.__dispatchElementPickerCleanup;
}

function closeOverlay(reason: "submitted" | "cancelled" | "failed"): void {
  if (closed) return;
  closed = true;
  cleanup();
  void send({ type: "overlay:closed", reason }).catch(() => undefined);
}

stopViewportTracking = onViewportChange(window, positionUI);
// Re-anchor the floating UI when its own content changes size (agent list
// loading in, error rows appearing) — bottom anchoring uses measured height.
const resizeObserver = new ResizeObserver(() => positionUI());
resizeObserver.observe(hint);
resizeObserver.observe(toolbar);
resizeObserver.observe(cardContainer);
window.addEventListener("pagehide", cleanup, { once: true });
window.__dispatchElementPickerCleanup = cleanup;
beginAiming();
