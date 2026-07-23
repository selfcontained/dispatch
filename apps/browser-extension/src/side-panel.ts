import "./side-panel.css";
import type {
  BrowserSelection,
  ConnectionStatus,
  DispatchAgent,
  WorkerRequest,
  WorkerResponse,
} from "./types";
import { usesInsecureHttp } from "./lib/dispatch-url";
import { canSubmitFeedback } from "./lib/feedback-form";
import { classifyPickerPage } from "./lib/picker-access";
import {
  captureElementScreenshot,
  type CaptureResult,
  type CapturedScreenshot,
} from "./lib/screenshot";

const SELECTIONS_KEY = "dispatchAgentSelections";
const INCLUDE_SCREENSHOT_KEY = "dispatchIncludeScreenshot";
const CAPTURE_TIMEOUT_MS = 4_000;
// captureVisibleTab (used for the element screenshot) requires all-URLs access,
// not per-host patterns, so page access is requested as a single <all_urls> grant
// that also covers the picker's content-script injection.
const PAGE_ACCESS_ORIGINS = ["<all_urls>"];
const SUCCESS_NOTICE_DURATION_MS = 4_000;
const PICKER_CLEANUP_ATTEMPTS = 3;
const PICKER_CLEANUP_RETRY_MS = 100;
const PICKER_CLEANUP_ERROR =
  "Element selector cleanup could not finish on every frame. Reload the inspected page before selecting again.";

interface PairingDetails {
  baseUrl: string;
  pairingId: string;
  pairingSecret: string;
  code: string;
  verificationPath: string;
  expiresAt: string;
}

interface PairingResult {
  status: "pending" | "approved";
  token?: string;
}

type Notice = {
  kind: "error" | "success" | "info";
  message: string;
  verificationCode?: string;
};

const appElement = document.querySelector<HTMLElement>("#app");
if (!appElement) throw new Error("Side panel root is missing.");
const app: HTMLElement = appElement;

let connection: ConnectionStatus = { connected: false };
let agents: DispatchAgent[] = [];
let selectedAgentId = "";
let selection: BrowserSelection | null = null;
let includeScreenshot = true;
let screenshot: CapturedScreenshot | null = null;
type ScreenshotStatus = "idle" | "capturing" | "ready" | "unavailable";
let screenshotStatus: ScreenshotStatus = "idle";
let screenshotFailureReason: string | null = null;
// Bumped whenever an in-flight capture becomes stale (new selection, opt-out,
// manual removal, submit). A capture only commits its result if its generation
// still matches, so a slow capture can never resurrect an opted-out image.
let captureGeneration = 0;
let comment = "";
let notice: Notice | null = null;
let busy = false;
let agentsRefreshing = false;
let pickerActive = false;
let pickerTabId: number | null = null;
let pickerWindowId: number | null = null;
let pickerTransitioning = false;
let pickerTransitionCount = 0;
let pageAccessGranted = false;
let pageAccessDisclosureVisible = false;
let pageAccessDenied = false;
let restorePickerFocus = false;
let connectionUrlInput = "";
let insecureAcknowledgedFor: string | null = null;
let noticeDismissTimer: number | null = null;
let pairingController: AbortController | null = null;
let pairingPermissionToRevoke: string | null = null;
let pairingInFlightExchange: Promise<PairingResult> | null = null;
let pendingSubmission: {
  id: string;
  agentId: string;
  comment: string;
  selection: BrowserSelection;
  screenshot: string | null;
} | null = null;

function cleanupInjectedPicker(): void {
  window.__dispatchElementPickerCleanup?.();
}

function injectedPickerIsReady(): boolean {
  return Boolean(
    window.__dispatchElementPickerCleanup &&
    document.querySelector("[data-dispatch-picker-overlay]")
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function cancellableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = (): void => {
      window.clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

class WorkerRequestError extends Error {
  constructor(
    message: string,
    readonly submissionTerminalFailure: boolean
  ) {
    super(message);
  }
}

async function sendWorker<T>(request: WorkerRequest): Promise<T> {
  const response = (await chrome.runtime.sendMessage(
    request
  )) as WorkerResponse<T>;
  if (!response?.ok) {
    throw new WorkerRequestError(
      response?.error ?? "Extension request failed.",
      response?.submissionTerminalFailure === true
    );
  }
  return response.data as T;
}

function setNotice(
  kind: Notice["kind"],
  message: string,
  verificationCode?: string,
  dismissAfterMs?: number
): void {
  if (noticeDismissTimer !== null) {
    window.clearTimeout(noticeDismissTimer);
    noticeDismissTimer = null;
  }
  const nextNotice = { kind, message, verificationCode };
  notice = nextNotice;
  const duration =
    dismissAfterMs ??
    (kind === "success" ? SUCCESS_NOTICE_DURATION_MS : undefined);
  if (duration !== undefined) {
    noticeDismissTimer = window.setTimeout(() => {
      noticeDismissTimer = null;
      if (notice !== nextNotice) return;
      notice = null;
      // Removing only the notice preserves the live textarea node, focus, and
      // caret while the user starts drafting their next comment.
      app.querySelector(".status")?.remove();
    }, duration);
  }
}

function normalizeUrlInput(input: string): URL {
  const withProtocol = /^https?:\/\//i.test(input.trim())
    ? input.trim()
    : `http://${input.trim()}`;
  return new URL(withProtocol);
}

function hostPermission(url: URL): string {
  return `${url.protocol}//${url.hostname}/*`;
}

async function getActiveTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab is available.");
  return tab;
}

function currentOrigin(): string | null {
  if (!selection) return null;
  try {
    return new URL(selection.page.url).origin;
  } catch {
    return null;
  }
}

function agentSelectionKey(baseUrl: string, origin: string): string {
  return `${baseUrl}|${origin}`;
}

// Invalidate any in-flight capture and drop the current image/status. Used when
// the user opts out, removes the image, or moves on to a new selection.
function resetCaptureState(): void {
  captureGeneration += 1;
  screenshot = null;
  screenshotStatus = "idle";
  screenshotFailureReason = null;
}

function applyCaptureResult(
  result: CaptureResult,
  generation: number,
  forSelection: BrowserSelection
): void {
  // Discard if a newer action superseded this capture (opt-out, removal, or a
  // new selection all bump the generation).
  if (generation !== captureGeneration || selection !== forSelection) return;
  if (result.ok) {
    screenshot = result.screenshot;
    screenshotStatus = "ready";
    screenshotFailureReason = null;
  } else {
    screenshot = null;
    screenshotStatus = "unavailable";
    screenshotFailureReason = result.reason;
    console.warn("[dispatch] screenshot capture failed:", result.reason);
  }
  render();
}

async function runCapture(
  forSelection: BrowserSelection,
  windowId: number
): Promise<void> {
  const generation = ++captureGeneration;
  screenshot = null;
  screenshotStatus = "capturing";
  screenshotFailureReason = null;
  render();

  // Bound the wait so a hung captureVisibleTab can't leave Send disabled forever.
  const result = await Promise.race([
    captureElementScreenshot(
      windowId,
      forSelection.element.rect,
      forSelection.page.devicePixelRatio
    ).catch(
      (error: unknown): CaptureResult => ({
        ok: false,
        reason: `capture threw: ${error instanceof Error ? error.message : String(error)}`,
      })
    ),
    new Promise<CaptureResult>((resolve) =>
      window.setTimeout(
        () => resolve({ ok: false, reason: "capture timed out" }),
        CAPTURE_TIMEOUT_MS
      )
    ),
  ]);

  applyCaptureResult(result, generation, forSelection);
}

async function recaptureForCurrentSelection(): Promise<void> {
  const forSelection = selection;
  if (!forSelection) return;
  const generation = ++captureGeneration;
  screenshot = null;
  screenshotStatus = "capturing";
  screenshotFailureReason = null;
  render();

  const tab = await getActiveTab().catch(() => null);
  if (generation !== captureGeneration || selection !== forSelection) return;

  let windowId: number | null = null;
  try {
    if (
      typeof tab?.windowId === "number" &&
      tab.url &&
      new URL(tab.url).origin === new URL(forSelection.page.url).origin
    ) {
      windowId = tab.windowId;
    }
  } catch {
    windowId = null;
  }

  if (windowId === null) {
    // The active tab no longer matches the inspected page, so we can't recapture.
    if (generation !== captureGeneration || selection !== forSelection) return;
    screenshotStatus = "unavailable";
    screenshotFailureReason =
      "active tab no longer matches the inspected page — switch back to it and try again";
    render();
    return;
  }
  await runCapture(forSelection, windowId);
}

function setIncludeScreenshot(next: boolean): void {
  includeScreenshot = next;
  void chrome.storage.local.set({ [INCLUDE_SCREENSHOT_KEY]: next });
  if (!next) {
    resetCaptureState();
    render();
    return;
  }
  render();
  // Re-enabling after a selection already exists still gives the user an image.
  if (selection && screenshotStatus !== "ready") {
    void recaptureForCurrentSelection();
  }
}

async function loadRememberedAgent(): Promise<void> {
  if (!connection.baseUrl) return;
  let origin = currentOrigin();
  if (!origin) {
    const tab = await getActiveTab().catch(() => null);
    try {
      origin = tab?.url ? new URL(tab.url).origin : null;
    } catch {
      origin = null;
    }
  }
  if (!origin) return;
  const stored = await chrome.storage.local.get(SELECTIONS_KEY);
  const selections = (stored[SELECTIONS_KEY] ?? {}) as Record<string, string>;
  const remembered = selections[agentSelectionKey(connection.baseUrl, origin)];
  if (remembered && agents.some((agent) => agent.id === remembered)) {
    selectedAgentId = remembered;
  }
}

async function rememberAgent(): Promise<void> {
  if (!connection.baseUrl || !selectedAgentId) return;
  let origin = currentOrigin();
  if (!origin) {
    const tab = await getActiveTab().catch(() => null);
    try {
      origin = tab?.url ? new URL(tab.url).origin : null;
    } catch {
      origin = null;
    }
  }
  if (!origin) return;
  const stored = await chrome.storage.local.get(SELECTIONS_KEY);
  const selections = (stored[SELECTIONS_KEY] ?? {}) as Record<string, string>;
  selections[agentSelectionKey(connection.baseUrl, origin)] = selectedAgentId;
  await chrome.storage.local.set({ [SELECTIONS_KEY]: selections });
}

function render(): void {
  app.replaceChildren();
  const shell = document.createElement("section");
  shell.className = "shell";

  const header = document.createElement("header");
  header.className = "header";
  const title = document.createElement("h1");
  title.textContent = "Dispatch feedback";
  header.append(title);

  if (connection.connected) {
    const disconnect = document.createElement("button");
    disconnect.className = "link-button";
    disconnect.type = "button";
    disconnect.textContent = "Disconnect";
    disconnect.addEventListener("click", () => void disconnectFromDispatch());
    header.append(disconnect);
  }
  shell.append(header);

  if (connection.connected) renderFeedback(shell);
  else renderConnection(shell);

  if (notice) {
    const status = document.createElement("div");
    status.className = `status ${notice.kind}`;
    status.setAttribute("role", notice.kind === "error" ? "alert" : "status");
    if (notice.verificationCode) {
      status.classList.add("verification");
      const label = document.createElement("p");
      label.className = "verification-label";
      label.textContent = "Confirm this code matches Dispatch";
      const code = document.createElement("code");
      code.className = "verification-code";
      code.textContent = notice.verificationCode;
      const instruction = document.createElement("p");
      instruction.className = "verification-instruction";
      instruction.textContent = notice.message;
      status.append(label, code, instruction);
    } else {
      status.textContent = notice.message;
    }
    shell.append(status);
  }
  app.append(shell);
}

function renderConnection(shell: HTMLElement): void {
  const form = document.createElement("form");
  form.className = "stack";
  const intro = document.createElement("p");
  intro.className = "subtle";
  intro.textContent =
    "Pair this browser with a Dispatch instance to send page feedback.";

  const label = document.createElement("label");
  label.textContent = "Dispatch URL";
  const input = document.createElement("input");
  input.name = "dispatchUrl";
  input.type = "url";
  input.required = true;
  input.placeholder = "http://localhost:6767";
  input.value = connectionUrlInput;
  input.disabled = busy;
  input.setAttribute("autocomplete", "url");
  input.addEventListener("input", () => {
    connectionUrlInput = input.value;
    insecureAcknowledgedFor = null;
  });
  label.append(input);

  const button = document.createElement("button");
  button.className = "primary";
  button.type = "submit";
  button.disabled = busy;
  button.textContent = busy
    ? pairingController
      ? "Waiting for approval…"
      : "Cancelling pairing…"
    : insecureAcknowledgedFor
      ? "Connect over HTTP"
      : "Connect to Dispatch";
  form.append(intro, label, button);
  if (busy && pairingController) {
    const cancel = document.createElement("button");
    cancel.className = "pairing-cancel";
    cancel.type = "button";
    cancel.textContent = "Cancel pairing";
    cancel.addEventListener("click", () => void cancelPairing());
    form.append(cancel);
  }
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void startPairing(input.value);
  });
  shell.append(form);
}

function renderFeedback(shell: HTMLElement): void {
  const connectionSummary = document.createElement("div");
  connectionSummary.className = "connection-summary";
  const connectionLabel = document.createElement("span");
  connectionLabel.className = "connection";
  connectionLabel.title = connection.baseUrl ?? "";
  connectionLabel.textContent = `Connected to ${connection.baseUrl}`;
  connectionSummary.append(connectionLabel);
  if (connection.baseUrl && usesInsecureHttp(connection.baseUrl)) {
    const insecureBadge = document.createElement("span");
    insecureBadge.className = "connection-security-badge";
    insecureBadge.textContent = "HTTP";
    insecureBadge.title =
      "This connection is not encrypted. Use it only on a trusted network.";
    insecureBadge.setAttribute("aria-label", insecureBadge.title);
    connectionSummary.append(insecureBadge);
  }

  const controls = document.createElement("div");
  controls.className = "stack";
  const send = document.createElement("button");
  const syncSendState = (): void => {
    // Hold Send while a capture is in flight so a fast submit can't drop the
    // screenshot the user asked for; failure/skip settles to a non-capturing
    // status and re-enables Send.
    send.disabled =
      screenshotStatus === "capturing" ||
      !canSubmitFeedback({
        busy,
        hasSelection: Boolean(selection),
        selectedAgentId,
        comment,
      });
  };
  const agentField = document.createElement("div");
  agentField.className = "agent-field";
  const agentHeader = document.createElement("div");
  agentHeader.className = "agent-field-header";
  const agentLabel = document.createElement("label");
  agentLabel.htmlFor = "dispatch-agent";
  agentLabel.textContent = "Send to agent";
  const refreshAgentsButton = document.createElement("button");
  refreshAgentsButton.type = "button";
  refreshAgentsButton.className = "agent-refresh";
  refreshAgentsButton.textContent = agentsRefreshing
    ? "Refreshing…"
    : "Refresh";
  refreshAgentsButton.setAttribute("aria-label", "Refresh running agents");
  refreshAgentsButton.disabled = busy || agentsRefreshing;
  refreshAgentsButton.addEventListener("click", () => void refreshAgents());
  agentHeader.append(agentLabel, refreshAgentsButton);
  const agentSelect = document.createElement("select");
  agentSelect.id = "dispatch-agent";
  agentSelect.disabled = busy || agentsRefreshing || agents.length === 0;
  if (agents.length === 0) {
    const option = document.createElement("option");
    option.textContent = "No running agents";
    option.value = "";
    agentSelect.append(option);
  } else {
    for (const agent of agents) {
      const option = document.createElement("option");
      option.value = agent.id;
      option.textContent = agent.repoName
        ? `${agent.name} — ${agent.repoName}`
        : agent.name;
      option.selected = agent.id === selectedAgentId;
      agentSelect.append(option);
    }
  }
  agentSelect.addEventListener("change", () => {
    selectedAgentId = agentSelect.value;
    syncSendState();
    void rememberAgent();
  });
  agentField.append(agentHeader, agentSelect);
  controls.append(agentField);

  const selectButton = document.createElement("button");
  const pickerControl = document.createElement("div");
  pickerControl.className = "picker-control";
  selectButton.type = "button";
  selectButton.disabled = busy || pickerTransitioning;
  selectButton.className = "picker-toggle";
  selectButton.setAttribute("aria-pressed", String(pickerActive));
  selectButton.setAttribute("aria-label", "Element selector");
  if (pickerActive) selectButton.classList.add("active");

  const pickerIcon = document.createElement("span");
  pickerIcon.className = "picker-toggle-icon";
  pickerIcon.setAttribute("aria-hidden", "true");
  pickerIcon.innerHTML = `
    <svg viewBox="0 0 24 24" focusable="false">
      <path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M9 20H5a1 1 0 0 1-1-1v-4" />
      <path d="m12 11 7.5 3.2-3.2 1.35-1.35 3.2L12 11Z" />
    </svg>`;

  const pickerCopy = document.createElement("span");
  pickerCopy.className = "picker-toggle-copy";
  const pickerTitle = document.createElement("span");
  pickerTitle.className = "picker-toggle-title";
  pickerTitle.textContent = "Element selector";
  const pickerAction = document.createElement("span");
  pickerAction.className = "picker-toggle-action";
  pickerAction.textContent = pickerActive
    ? "Click to stop selecting"
    : selection
      ? "Pick a different element"
      : pageAccessGranted
        ? "Click to inspect the page"
        : "Grant page access to inspect";
  pickerCopy.append(pickerTitle, pickerAction);

  const pickerState = document.createElement("span");
  pickerState.className = "picker-toggle-state";
  const pickerStateDot = document.createElement("span");
  pickerStateDot.className = "picker-toggle-state-dot";
  pickerStateDot.setAttribute("aria-hidden", "true");
  const pickerStateLabel = document.createElement("span");
  pickerStateLabel.textContent = pickerActive ? "On" : "Off";
  pickerState.append(pickerStateDot, pickerStateLabel);
  selectButton.append(pickerIcon, pickerCopy, pickerState);
  selectButton.addEventListener("click", () => {
    restorePickerFocus = true;
    selectButton.disabled = true;
    void handleSelectorClick();
  });
  if (restorePickerFocus && !pickerTransitioning) {
    queueMicrotask(() => {
      selectButton.focus();
      restorePickerFocus = false;
    });
  }

  const pickerHelpSlot = document.createElement("div");
  pickerHelpSlot.className = "picker-help-slot";
  pickerHelpSlot.setAttribute("aria-live", "polite");
  pickerHelpSlot.setAttribute("aria-atomic", "true");
  if (pickerActive) {
    const pickerHelp = document.createElement("p");
    pickerHelp.className = "picker-help";
    pickerHelp.textContent =
      "Hover to inspect · Click to select · Escape to cancel";
    pickerHelpSlot.append(pickerHelp);
  }
  pickerControl.append(selectButton, pickerHelpSlot);
  controls.append(pickerControl);
  controls.append(createScreenshotToggle());
  if (pageAccessDisclosureVisible && !pageAccessGranted) {
    controls.append(createPageAccessDisclosure());
  }

  if (selection) controls.append(createPreview());
  else {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent =
      "Select an element to preview the context that will be shared.";
    controls.append(empty);
  }

  const commentLabel = document.createElement("label");
  commentLabel.textContent = "Comment";
  const textarea = document.createElement("textarea");
  textarea.maxLength = 10_000;
  textarea.placeholder =
    "Describe what should change or what the agent should investigate…";
  textarea.value = comment;
  textarea.disabled = busy;
  textarea.addEventListener("input", () => {
    comment = textarea.value;
    syncSendState();
  });
  commentLabel.append(textarea);
  controls.append(commentLabel);

  send.className = "primary";
  send.type = "button";
  syncSendState();
  send.textContent = busy
    ? "Sending…"
    : screenshotStatus === "capturing"
      ? "Preparing screenshot…"
      : "Send to agent";
  send.addEventListener("click", () => void submitFeedback());
  controls.append(send);
  shell.append(connectionSummary, controls);
}

function createScreenshotToggle(): HTMLElement {
  const wrapper = document.createElement("label");
  wrapper.className = "screenshot-toggle";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = includeScreenshot;
  input.disabled = busy;
  input.addEventListener("change", () => setIncludeScreenshot(input.checked));
  const text = document.createElement("span");
  text.textContent = "Include screenshot of selected element";
  wrapper.append(input, text);
  return wrapper;
}

function createPreview(): HTMLElement {
  const preview = document.createElement("section");
  preview.className = "preview";
  const header = document.createElement("div");
  header.className = "preview-header";
  const page = document.createElement("p");
  page.textContent =
    selection?.page.title || selection?.page.url || "Selected page";
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "preview-clear";
  clear.textContent = "Clear selection";
  clear.setAttribute("aria-label", "Clear selected element");
  clear.disabled = busy;
  clear.addEventListener("click", () => {
    selection = null;
    resetCaptureState();
    render();
  });
  header.append(page, clear);
  const selector = document.createElement("code");
  selector.textContent = selection?.element.selector ?? "";
  const text = document.createElement("p");
  text.textContent = selection?.element.text || "No visible text";
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = "Sanitized HTML context";
  const html = document.createElement("pre");
  html.textContent = selection?.element.outerHtml ?? "";
  details.append(summary, html);

  const surroundingDetails = document.createElement("details");
  const surroundingSummary = document.createElement("summary");
  surroundingSummary.textContent = "Locator and surrounding context";
  const surroundingContext = document.createElement("pre");
  surroundingContext.textContent = selection
    ? JSON.stringify(
        {
          xpath: selection.element.xpath,
          ancestors: selection.element.ancestors,
          nearbyElements: selection.element.nearbyElements,
          searchHints: selection.element.searchHints,
        },
        null,
        2
      )
    : "";
  surroundingDetails.append(surroundingSummary, surroundingContext);
  preview.append(header, selector, text);
  if (screenshot) preview.append(createScreenshotFigure(screenshot));
  else if (screenshotStatus === "capturing")
    preview.append(createScreenshotStatus("capturing"));
  else if (screenshotStatus === "unavailable")
    preview.append(createScreenshotStatus("unavailable"));
  preview.append(details, surroundingDetails);
  return preview;
}

function createScreenshotStatus(
  kind: "capturing" | "unavailable"
): HTMLElement {
  const status = document.createElement("div");
  status.className = `screenshot-status ${kind}`;
  status.setAttribute("aria-live", "polite");
  const message = document.createElement("p");
  message.className = "screenshot-status-message";
  if (kind === "capturing") {
    message.textContent = "Capturing screenshot…";
    status.append(message);
    return status;
  }
  message.textContent =
    "Screenshot couldn’t be captured; this feedback will be sent without one.";
  status.append(message);
  if (screenshotFailureReason) {
    const reason = document.createElement("p");
    reason.className = "screenshot-status-reason";
    reason.textContent = screenshotFailureReason;
    status.append(reason);
  }
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "screenshot-retry";
  retry.textContent = "Try again";
  retry.setAttribute("aria-label", "Try capturing the screenshot again");
  retry.disabled = busy;
  retry.addEventListener("click", () => void recaptureForCurrentSelection());
  status.append(retry);
  return status;
}

function createScreenshotFigure(shot: CapturedScreenshot): HTMLElement {
  const figure = document.createElement("figure");
  figure.className = "screenshot-figure";
  const image = document.createElement("img");
  image.className = "screenshot-image";
  image.src = shot.dataUrl;
  image.alt = "Screenshot of the selected element";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "screenshot-remove";
  remove.textContent = "Remove screenshot";
  remove.setAttribute("aria-label", "Remove screenshot from this submission");
  remove.disabled = busy;
  remove.addEventListener("click", () => {
    // Explicit removal: drop the image and don't show the "couldn't capture"
    // status, and cancel any capture that might still be resolving.
    resetCaptureState();
    render();
  });
  figure.append(image, remove);
  return figure;
}

function createPageAccessDisclosure(): HTMLElement {
  const disclosure = document.createElement("section");
  disclosure.className = `page-access-disclosure${pageAccessDenied ? " denied" : ""}`;
  disclosure.setAttribute("aria-live", "polite");
  const title = document.createElement("strong");
  title.textContent = pageAccessDenied
    ? "Page access was denied"
    : "Allow page inspection";
  const explanation = document.createElement("p");
  explanation.textContent = pageAccessDenied
    ? "Chrome did not grant access. Try again to reopen its permission prompt, or dismiss this request."
    : "Element selection needs permission to read and change page content, including embedded frames, on the websites you visit — the screenshot capture requires all-sites access. While the selector is on, Dispatch reads hovered elements locally to draw the highlight. It sends the selected element, surrounding page context, and — when the screenshot option is on — an image of that element only after you click it; Chrome lets you revoke access later.";
  const actions = document.createElement("div");
  actions.className = "page-access-actions";
  const allow = document.createElement("button");
  allow.type = "button";
  allow.className = "primary";
  allow.textContent = pageAccessDenied
    ? "Try page access again"
    : "Allow page access";
  allow.disabled = pickerTransitioning;
  allow.addEventListener("click", () => {
    restorePickerFocus = true;
    allow.disabled = true;
    void togglePicker();
  });
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.textContent = "Not now";
  dismiss.disabled = pickerTransitioning;
  dismiss.addEventListener("click", () => {
    pageAccessDisclosureVisible = false;
    pageAccessDenied = false;
    render();
  });
  actions.append(allow, dismiss);
  disclosure.append(title, explanation, actions);
  return disclosure;
}

async function startPairing(input: string): Promise<void> {
  let requestedPermission: string | null = null;
  let permissionWasAlreadyGranted = false;
  let controller: AbortController | null = null;
  try {
    const url = normalizeUrlInput(input);
    connectionUrlInput = url.origin;
    if (
      usesInsecureHttp(url.origin) &&
      insecureAcknowledgedFor !== url.origin
    ) {
      insecureAcknowledgedFor = url.origin;
      setNotice(
        "info",
        "HTTP sends pairing credentials and feedback without encryption. Continue only if you trust this network."
      );
      render();
      return;
    }

    requestedPermission = hostPermission(url);
    permissionWasAlreadyGranted = await chrome.permissions.contains({
      origins: [requestedPermission],
    });
    const granted = await chrome.permissions.request({
      origins: [requestedPermission],
    });
    if (!granted) throw new Error("Dispatch host access was not approved.");
    pairingController?.abort();
    controller = new AbortController();
    pairingController = controller;
    pairingPermissionToRevoke = permissionWasAlreadyGranted
      ? null
      : requestedPermission;
    busy = true;
    setNotice("info", "Starting pairing…");
    render();
    const pairing = await sendWorker<PairingDetails>({
      type: "pairing:start",
      baseUrl: url.origin,
    });
    controller.signal.throwIfAborted();
    const verificationUrl = new URL(pairing.verificationPath, pairing.baseUrl);
    if (verificationUrl.origin !== pairing.baseUrl) {
      throw new Error("Dispatch returned an invalid pairing page URL.");
    }
    await chrome.tabs.create({ url: verificationUrl.href, active: true });
    controller.signal.throwIfAborted();
    setNotice(
      "info",
      "Approve the connection there only if it shows the same code.",
      pairing.code
    );
    render();
    await pollPairing(pairing, controller.signal);
    pairingPermissionToRevoke = null;
  } catch (error) {
    if (controller?.signal.aborted) return;
    if (requestedPermission && !permissionWasAlreadyGranted) {
      await chrome.permissions
        .remove({ origins: [requestedPermission] })
        .catch(() => false);
    }
    pairingPermissionToRevoke = null;
    busy = false;
    setNotice(
      "error",
      error instanceof Error ? error.message : "Pairing failed."
    );
    render();
  } finally {
    if (controller && pairingController === controller) {
      pairingController = null;
    }
  }
}

async function cancelPairing(): Promise<void> {
  const permissionToRevoke = pairingPermissionToRevoke;
  const inFlightExchange = pairingInFlightExchange;
  pairingController?.abort(
    new DOMException("Pairing was cancelled.", "AbortError")
  );
  pairingController = null;
  pairingPermissionToRevoke = null;
  setNotice("info", "Cancelling pairing…");
  render();
  const lateResult = await inFlightExchange?.catch(() => null);
  if (lateResult?.status === "approved") {
    await sendWorker<{ revokedRemotely: boolean }>({
      type: "connection:disconnect",
    }).catch(() => null);
  }
  if (permissionToRevoke) {
    await chrome.permissions
      .remove({ origins: [permissionToRevoke] })
      .catch(() => false);
  }
  busy = false;
  setNotice("info", "Pairing cancelled. You can connect again immediately.");
  render();
}

async function pollPairing(
  pairing: PairingDetails,
  signal: AbortSignal
): Promise<void> {
  const expiresAt = Date.parse(pairing.expiresAt);
  while (Date.now() < expiresAt) {
    await cancellableDelay(2_500, signal);
    const exchange = sendWorker<PairingResult>({
      type: "pairing:exchange",
      baseUrl: pairing.baseUrl,
      pairingId: pairing.pairingId,
      pairingSecret: pairing.pairingSecret,
    });
    pairingInFlightExchange = exchange;
    let result: PairingResult;
    try {
      result = await exchange;
    } finally {
      if (pairingInFlightExchange === exchange) pairingInFlightExchange = null;
    }
    signal.throwIfAborted();
    if (result.status !== "approved") continue;
    connection = { connected: true, baseUrl: pairing.baseUrl };
    insecureAcknowledgedFor = null;
    busy = false;
    setNotice(
      usesInsecureHttp(pairing.baseUrl) ? "info" : "success",
      usesInsecureHttp(pairing.baseUrl)
        ? "Connected over HTTP. Credentials are unencrypted; use a trusted network."
        : "Browser connected to Dispatch.",
      undefined,
      6_000
    );
    await loadAgents();
    render();
    return;
  }
  throw new Error("Pairing expired. Start the connection again.");
}

async function disconnectFromDispatch(): Promise<void> {
  if (pickerActive) await stopPicker(false);
  const baseUrl = connection.baseUrl;
  const result = await sendWorker<{ revokedRemotely: boolean }>({
    type: "connection:disconnect",
  });
  if (baseUrl) {
    await chrome.permissions
      .remove({ origins: [hostPermission(new URL(baseUrl))] })
      .catch(() => false);
  }
  await chrome.permissions
    .remove({ origins: PAGE_ACCESS_ORIGINS })
    .catch(() => false);
  pageAccessGranted = false;
  connection = { connected: false };
  agents = [];
  selectedAgentId = "";
  selection = null;
  resetCaptureState();
  comment = "";
  pendingSubmission = null;
  notice = result.revokedRemotely
    ? null
    : {
        kind: "info",
        message:
          "Disconnected locally, but Dispatch could not be reached to revoke this browser. Revoke it from Dispatch settings when the server is available.",
      };
  render();
}

async function loadAgents(preserveCurrent = false): Promise<boolean> {
  try {
    const previousAgentId = selectedAgentId;
    const result = await sendWorker<{ agents: DispatchAgent[] }>({
      type: "agents:list",
    });
    agents = result.agents;
    if (
      preserveCurrent &&
      agents.some((agent) => agent.id === previousAgentId)
    ) {
      selectedAgentId = previousAgentId;
    } else {
      selectedAgentId = agents[0]?.id ?? "";
      await loadRememberedAgent();
    }
    return true;
  } catch (error) {
    const refreshedConnection = await sendWorker<ConnectionStatus>({
      type: "connection:status",
    }).catch(() => null);
    if (refreshedConnection && !refreshedConnection.connected) {
      connection = refreshedConnection;
      agents = [];
      selectedAgentId = "";
    }
    setNotice(
      "error",
      error instanceof Error ? error.message : "Could not load agents."
    );
    return false;
  }
}

async function refreshAgents(): Promise<void> {
  if (agentsRefreshing) return;
  agentsRefreshing = true;
  notice = null;
  render();
  await loadAgents(true);
  agentsRefreshing = false;
  render();
}

function disarmPicker(): { tabId: number | null; windowId: number | null } {
  const state = { tabId: pickerTabId, windowId: pickerWindowId };
  pickerActive = false;
  pickerTabId = null;
  pickerWindowId = null;
  return state;
}

function beginPickerTransition(): void {
  pickerTransitionCount += 1;
  pickerTransitioning = true;
}

function endPickerTransition(): void {
  pickerTransitionCount = Math.max(0, pickerTransitionCount - 1);
  pickerTransitioning = pickerTransitionCount > 0;
}

async function cleanupPickerInTab(tabId: number): Promise<boolean> {
  for (let attempt = 0; attempt < PICKER_CLEANUP_ATTEMPTS; attempt += 1) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: cleanupInjectedPicker,
      });
      return true;
    } catch {
      if (attempt < PICKER_CLEANUP_ATTEMPTS - 1) {
        await delay(PICKER_CLEANUP_RETRY_MS);
      }
    }
  }
  return false;
}

async function stopPicker(renderAfter = true): Promise<boolean> {
  const { tabId } = disarmPicker();
  let cleaned = true;
  if (tabId !== null) {
    cleaned = await cleanupPickerInTab(tabId);
  }
  if (renderAfter) render();
  return cleaned;
}

async function injectPicker(tabId: number, windowId: number): Promise<void> {
  // Arm message acceptance before injection. A user can click immediately after
  // picker.js installs, before the readiness probe returns to this panel.
  pickerActive = true;
  pickerTabId = tabId;
  pickerWindowId = windowId;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (!pickerActive || pickerTabId !== tabId) return;
    try {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        files: ["picker.js"],
      });
      if (!pickerActive || pickerTabId !== tabId) return;
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: injectedPickerIsReady,
      });
      if (!pickerActive || pickerTabId !== tabId) return;
      if (results.some((result) => result.result === true)) {
        return;
      }
    } catch {
      // A new host grant can take a moment to reach scripting.executeScript.
      // Retry below after removing any partial injection from accessible frames.
    }

    await chrome.scripting
      .executeScript({
        target: { tabId, allFrames: true },
        func: cleanupInjectedPicker,
      })
      .catch(() => {
        // Host access may still be propagating, so cleanup can fail as well.
      });
    await delay(150);
  }
  throw new Error("Element selection did not start on this page. Try again.");
}

async function requestPageAccess(): Promise<boolean> {
  const wasAlreadyGranted = pageAccessGranted;
  const granted = await chrome.permissions.request({
    origins: PAGE_ACCESS_ORIGINS,
  });
  if (!granted) {
    pageAccessDisclosureVisible = true;
    pageAccessDenied = true;
    throw new Error(
      "Chrome denied page access. Use Try page access again below to reopen the permission prompt."
    );
  }
  pageAccessGranted = true;
  pageAccessDisclosureVisible = false;
  pageAccessDenied = false;
  return !wasAlreadyGranted;
}

async function handleSelectorClick(): Promise<void> {
  if (pickerActive) {
    await togglePicker(false);
    return;
  }
  try {
    pageAccessGranted = await chrome.permissions.contains({
      origins: PAGE_ACCESS_ORIGINS,
    });
  } catch (error) {
    setNotice(
      "error",
      error instanceof Error
        ? error.message
        : "Chrome could not verify page access."
    );
    render();
    return;
  }
  if (!pageAccessGranted) {
    pageAccessDisclosureVisible = true;
    pageAccessDenied = false;
    render();
    return;
  }
  pageAccessDisclosureVisible = false;
  pageAccessDenied = false;
  await togglePicker(false);
}

async function getSettledTab(tabId: number): Promise<chrome.tabs.Tab> {
  let lastReadyTabId: number | null = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const tab = await chrome.tabs.get(tabId);
    const pageAccess = classifyPickerPage(tab.url);
    if (pageAccess === "unsupported") return tab;
    const isReady =
      (tab.status === undefined || tab.status === "complete") &&
      pageAccess === "ready";
    if (isReady && tab.id === lastReadyTabId) return tab;
    lastReadyTabId = isReady ? (tab.id as number) : null;
    await delay(100);
  }
  throw new Error(
    "Chrome is still applying page access. Try Element selector again."
  );
}

async function togglePicker(requestAccess = true): Promise<void> {
  if (pickerTransitioning) return;
  beginPickerTransition();

  try {
    if (pickerActive) {
      const cleaned = await stopPicker(false);
      if (!cleaned) throw new Error(PICKER_CLEANUP_ERROR);
      return;
    }

    notice = null;
    // Start resolving the intended tab without awaiting so permissions.request
    // still runs in the selector button's original user-gesture call stack.
    const intendedTabPromise = getActiveTab();
    const accessWasNewlyGranted = requestAccess
      ? await requestPageAccess()
      : false;
    const intendedTab = await intendedTabPromise;
    const tab = accessWasNewlyGranted
      ? await getSettledTab(intendedTab.id as number)
      : await chrome.tabs.get(intendedTab.id as number);
    const pageAccess = classifyPickerPage(tab.url);
    if (pageAccess !== "ready") {
      throw new Error(
        "Chrome does not allow element selection on this page. Try a normal HTTP or HTTPS website."
      );
    }
    await injectPicker(tab.id as number, tab.windowId);
  } catch (error) {
    disarmPicker();
    setNotice(
      "error",
      error instanceof Error
        ? error.message
        : "Could not start element selection."
    );
  } finally {
    endPickerTransition();
    render();
  }
}

async function submitFeedback(): Promise<void> {
  if (!selection || !selectedAgentId || !comment.trim()) return;
  const submittedSelection = selection;
  const submittedComment = comment.trim();
  const submittedScreenshot = screenshot?.base64 ?? null;
  if (
    !pendingSubmission ||
    pendingSubmission.agentId !== selectedAgentId ||
    pendingSubmission.comment !== submittedComment ||
    pendingSubmission.selection !== submittedSelection ||
    pendingSubmission.screenshot !== submittedScreenshot
  ) {
    pendingSubmission = {
      id: crypto.randomUUID(),
      agentId: selectedAgentId,
      comment: submittedComment,
      selection: submittedSelection,
      screenshot: submittedScreenshot,
    };
  }
  busy = true;
  notice = null;
  render();
  try {
    await sendWorker({
      type: "submission:create",
      clientSubmissionId: pendingSubmission.id,
      agentId: pendingSubmission.agentId,
      comment: pendingSubmission.comment,
      selection: pendingSubmission.selection,
      screenshot: pendingSubmission.screenshot ?? undefined,
    });
    pendingSubmission = null;
    comment = "";
    selection = null;
    resetCaptureState();
    setNotice("success", "Feedback delivered to the selected agent.");
  } catch (error) {
    if (
      error instanceof WorkerRequestError &&
      error.submissionTerminalFailure
    ) {
      pendingSubmission = null;
    }
    const refreshedConnection = await sendWorker<ConnectionStatus>({
      type: "connection:status",
    }).catch(() => null);
    if (refreshedConnection && !refreshedConnection.connected) {
      connection = refreshedConnection;
      agents = [];
      selectedAgentId = "";
    }
    setNotice(
      "error",
      error instanceof Error ? error.message : "Feedback could not be sent."
    );
  } finally {
    busy = false;
    render();
  }
}

chrome.runtime.onMessage.addListener((message: unknown, sender) => {
  if (!message || typeof message !== "object" || !("type" in message)) return;
  if (
    typeof message.type === "string" &&
    message.type.startsWith("picker:") &&
    (!pickerActive || pickerTabId === null || sender.tab?.id !== pickerTabId)
  ) {
    return;
  }
  const completedPickerTabId = pickerTabId;
  let handled = false;
  if (message.type === "picker:selected" && "selection" in message) {
    handled = true;
    beginPickerTransition();
    const nextSelection = message.selection as BrowserSelection;
    resetCaptureState();
    selection = nextSelection;
    disarmPicker();
    notice = null;
    void rememberAgent();
    if (includeScreenshot) {
      // captureVisibleTab only sees the top document, so element rects from
      // nested frames can't be cropped reliably — mark those unavailable so the
      // user learns no screenshot will be attached.
      if (sender.frameId === 0 && typeof sender.tab?.windowId === "number") {
        void runCapture(nextSelection, sender.tab.windowId);
      } else {
        screenshotStatus = "unavailable";
        screenshotFailureReason =
          "element is inside a nested frame — capture only supports the top-level page";
      }
    }
    render();
  } else if (message.type === "picker:cancelled") {
    handled = true;
    beginPickerTransition();
    disarmPicker();
    notice = null;
    render();
  } else if (message.type === "picker:failed") {
    handled = true;
    beginPickerTransition();
    disarmPicker();
    setNotice(
      "error",
      "Could not collect context for that element. Try a different element."
    );
    render();
  }
  if (handled && completedPickerTabId !== null) {
    void cleanupPickerInTab(completedPickerTabId).then((cleaned) => {
      if (!cleaned) setNotice("error", PICKER_CLEANUP_ERROR);
      endPickerTransition();
      render();
    });
  }
});

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  if (
    !pickerActive ||
    tabId === pickerTabId ||
    (pickerWindowId !== null && windowId !== pickerWindowId)
  ) {
    return;
  }
  void stopPicker(false).then((cleaned) => {
    setNotice(
      cleaned ? "info" : "error",
      cleaned
        ? "Element selection stopped because you switched tabs."
        : PICKER_CLEANUP_ERROR
    );
    render();
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (
    pickerActive &&
    tabId === pickerTabId &&
    changeInfo.status === "loading"
  ) {
    disarmPicker();
    setNotice("info", "Element selection stopped because the page changed.");
    render();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (!pickerActive || tabId !== pickerTabId) return;
  disarmPicker();
  render();
});

window.addEventListener("pagehide", () => {
  const { tabId } = disarmPicker();
  if (tabId !== null) {
    void cleanupPickerInTab(tabId);
  }
});

async function initialize(): Promise<void> {
  try {
    pageAccessGranted = await chrome.permissions.contains({
      origins: PAGE_ACCESS_ORIGINS,
    });
    const storedToggle = await chrome.storage.local.get(INCLUDE_SCREENSHOT_KEY);
    if (typeof storedToggle[INCLUDE_SCREENSHOT_KEY] === "boolean") {
      includeScreenshot = storedToggle[INCLUDE_SCREENSHOT_KEY];
    }
    connection = await sendWorker<ConnectionStatus>({
      type: "connection:status",
    });
    if (connection.connected) await loadAgents();
  } catch (error) {
    setNotice(
      "error",
      error instanceof Error ? error.message : "Extension failed to start."
    );
  }
  render();
}

void initialize();
