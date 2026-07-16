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

const SELECTIONS_KEY = "dispatchAgentSelections";
const PAGE_ACCESS_ORIGINS = ["http://*/*", "https://*/*"];

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
let comment = "";
let notice: Notice | null = null;
let busy = false;
let pickerActive = false;
let pickerTabId: number | null = null;
let pickerTransitioning = false;
let pageAccessGranted = false;
let restorePickerFocus = false;
let connectionUrlInput = "";
let insecureAcknowledgedFor: string | null = null;

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

async function sendWorker<T>(request: WorkerRequest): Promise<T> {
  const response = (await chrome.runtime.sendMessage(
    request
  )) as WorkerResponse<T>;
  if (!response?.ok)
    throw new Error(response?.error ?? "Extension request failed.");
  return response.data as T;
}

function setNotice(
  kind: Notice["kind"],
  message: string,
  verificationCode?: string,
  dismissAfterMs?: number
): void {
  const nextNotice = { kind, message, verificationCode };
  notice = nextNotice;
  if (dismissAfterMs) {
    window.setTimeout(() => {
      if (notice !== nextNotice) return;
      notice = null;
      render();
    }, dismissAfterMs);
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
    ? "Waiting for approval…"
    : insecureAcknowledgedFor
      ? "Connect over HTTP"
      : "Connect to Dispatch";
  form.append(intro, label, button);
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
    send.disabled = !canSubmitFeedback({
      busy,
      hasSelection: Boolean(selection),
      selectedAgentId,
      comment,
    });
  };
  const agentLabel = document.createElement("label");
  agentLabel.textContent = "Send to agent";
  const agentSelect = document.createElement("select");
  agentSelect.disabled = busy || agents.length === 0;
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
  agentLabel.append(agentSelect);
  controls.append(agentLabel);

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
    void togglePicker();
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
  send.textContent = busy ? "Sending…" : "Send to agent";
  send.addEventListener("click", () => void submitFeedback());
  controls.append(send);
  shell.append(connectionSummary, controls);
}

function createPreview(): HTMLElement {
  const preview = document.createElement("section");
  preview.className = "preview";
  const page = document.createElement("p");
  page.textContent =
    selection?.page.title || selection?.page.url || "Selected page";
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
  preview.append(page, selector, text, details, surroundingDetails);
  return preview;
}

async function startPairing(input: string): Promise<void> {
  let requestedPermission: string | null = null;
  let permissionWasAlreadyGranted = false;
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
    busy = true;
    setNotice("info", "Starting pairing…");
    render();
    const pairing = await sendWorker<PairingDetails>({
      type: "pairing:start",
      baseUrl: url.origin,
    });
    const verificationUrl = new URL(pairing.verificationPath, pairing.baseUrl);
    if (verificationUrl.origin !== pairing.baseUrl) {
      throw new Error("Dispatch returned an invalid pairing page URL.");
    }
    await chrome.tabs.create({ url: verificationUrl.href, active: true });
    setNotice(
      "info",
      "Approve the connection there only if it shows the same code.",
      pairing.code
    );
    render();
    await pollPairing(pairing);
  } catch (error) {
    if (requestedPermission && !permissionWasAlreadyGranted) {
      await chrome.permissions
        .remove({ origins: [requestedPermission] })
        .catch(() => false);
    }
    busy = false;
    setNotice(
      "error",
      error instanceof Error ? error.message : "Pairing failed."
    );
    render();
  }
}

async function pollPairing(pairing: PairingDetails): Promise<void> {
  const expiresAt = Date.parse(pairing.expiresAt);
  while (Date.now() < expiresAt) {
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    const result = await sendWorker<PairingResult>({
      type: "pairing:exchange",
      baseUrl: pairing.baseUrl,
      pairingId: pairing.pairingId,
      pairingSecret: pairing.pairingSecret,
    });
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
  comment = "";
  notice = result.revokedRemotely
    ? null
    : {
        kind: "info",
        message:
          "Disconnected locally, but Dispatch could not be reached to revoke this browser. Revoke it from Dispatch settings when the server is available.",
      };
  render();
}

async function loadAgents(): Promise<void> {
  try {
    const result = await sendWorker<{ agents: DispatchAgent[] }>({
      type: "agents:list",
    });
    agents = result.agents;
    selectedAgentId = agents[0]?.id ?? "";
    await loadRememberedAgent();
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
  }
}

async function stopPicker(renderAfter = true): Promise<void> {
  const tabId = pickerTabId;
  pickerActive = false;
  pickerTabId = null;
  if (tabId !== null) {
    await chrome.scripting
      .executeScript({
        target: { tabId },
        func: cleanupInjectedPicker,
      })
      .catch(() => {
        // The inspected tab may have navigated or closed; local state is still disarmed.
      });
  }
  if (renderAfter) render();
}

async function injectPicker(tabId: number): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["picker.js"],
    });
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: injectedPickerIsReady,
    });
    if (result?.result === true) {
      pickerActive = true;
      pickerTabId = tabId;
      return;
    }
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
    throw new Error(
      "Page access was not granted. Click Element selector to try again."
    );
  }
  pageAccessGranted = true;
  return !wasAlreadyGranted;
}

async function getSettledActiveTab(): Promise<chrome.tabs.Tab> {
  let lastCompleteTabId: number | null = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const tab = await getActiveTab();
    const isComplete = tab.status === undefined || tab.status === "complete";
    if (isComplete && tab.id === lastCompleteTabId) return tab;
    lastCompleteTabId = isComplete ? (tab.id as number) : null;
    await delay(100);
  }
  throw new Error("The page is still loading. Try Element selector again.");
}

async function togglePicker(): Promise<void> {
  if (pickerTransitioning) return;
  pickerTransitioning = true;

  try {
    if (pickerActive) {
      await stopPicker(false);
      return;
    }

    notice = null;
    const accessWasNewlyGranted = await requestPageAccess();
    const tab = accessWasNewlyGranted
      ? await getSettledActiveTab()
      : await getActiveTab();
    const pageAccess = classifyPickerPage(tab.url);
    if (pageAccess !== "ready") {
      throw new Error(
        "Chrome does not allow element selection on this page. Try a normal HTTP or HTTPS website."
      );
    }
    await injectPicker(tab.id as number);
  } catch (error) {
    pickerActive = false;
    pickerTabId = null;
    setNotice(
      "error",
      error instanceof Error
        ? error.message
        : "Could not start element selection."
    );
  } finally {
    pickerTransitioning = false;
    render();
  }
}

async function submitFeedback(): Promise<void> {
  if (!selection || !selectedAgentId || !comment.trim()) return;
  busy = true;
  notice = null;
  render();
  try {
    await sendWorker({
      type: "submission:create",
      agentId: selectedAgentId,
      comment: comment.trim(),
      selection,
    });
    comment = "";
    selection = null;
    setNotice("success", "Feedback delivered to the selected agent.");
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
  if (message.type === "picker:selected" && "selection" in message) {
    selection = message.selection as BrowserSelection;
    pickerActive = false;
    pickerTabId = null;
    notice = null;
    void rememberAgent();
    render();
  } else if (message.type === "picker:cancelled") {
    pickerActive = false;
    pickerTabId = null;
    notice = null;
    render();
  } else if (message.type === "picker:failed") {
    pickerActive = false;
    pickerTabId = null;
    setNotice(
      "error",
      "Could not collect context for that element. Try a different element."
    );
    render();
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (
    pickerActive &&
    tabId === pickerTabId &&
    changeInfo.status === "loading"
  ) {
    pickerActive = false;
    pickerTabId = null;
    setNotice("info", "Element selection stopped because the page changed.");
    render();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (!pickerActive || tabId !== pickerTabId) return;
  pickerActive = false;
  pickerTabId = null;
  render();
});

window.addEventListener("pagehide", () => {
  const tabId = pickerTabId;
  pickerActive = false;
  pickerTabId = null;
  if (tabId !== null) {
    void chrome.scripting
      .executeScript({
        target: { tabId },
        func: cleanupInjectedPicker,
      })
      .catch(() => {
        // Closing the inspected tab and the panel together requires no cleanup retry.
      });
  }
});

async function initialize(): Promise<void> {
  try {
    pageAccessGranted = await chrome.permissions.contains({
      origins: PAGE_ACCESS_ORIGINS,
    });
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
