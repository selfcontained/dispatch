import "./popup.css";
import {
  type ArmFailureCode,
  type ConnectionStatus,
  type PairingSessionState,
  type SafariRequest,
  type WorkerRequest,
  type WorkerResponse,
} from "../types";
import { api } from "../lib/extension-api";
import { usesInsecureHttp } from "../lib/dispatch-url";
import {
  initialPopupState,
  reducePopupState,
  type PopupEvent,
  type PopupState,
} from "./popup-state";

const PAIRING_REFRESH_MS = 2_000;

const appElement = document.querySelector<HTMLElement>("#app");
if (!appElement) throw new Error("Popup root is missing.");
const app: HTMLElement = appElement;

let state: PopupState = initialPopupState;
let pairingRefreshTimer: number | null = null;

class RequestFailure extends Error {
  constructor(
    message: string,
    readonly code: ArmFailureCode | undefined
  ) {
    super(message);
  }
}

async function send<T>(request: WorkerRequest | SafariRequest): Promise<T> {
  const response = (await api.runtime.sendMessage(
    request
  )) as WorkerResponse<T>;
  if (!response?.ok) {
    throw new RequestFailure(
      response?.error ?? "Extension request failed.",
      response?.code
    );
  }
  return response.data as T;
}

function dispatch(event: PopupEvent): void {
  state = reducePopupState(state, event);
  render();
}

function normalizeUrlInput(input: string): URL {
  const withProtocol = /^https?:\/\//i.test(input.trim())
    ? input.trim()
    : `http://${input.trim()}`;
  return new URL(withProtocol);
}

async function refreshStatus(): Promise<void> {
  try {
    const [pairing, connection] = await Promise.all([
      send<PairingSessionState>({ type: "pairing:status" }),
      send<ConnectionStatus>({ type: "connection:status" }),
    ]);
    dispatch({ type: "status", pairing, connection });
  } catch (error) {
    dispatch({
      type: "status-failed",
      error:
        error instanceof Error ? error.message : "Extension request failed.",
    });
  }
}

function syncPairingRefresh(): void {
  const shouldPoll = state.view === "pairing";
  if (shouldPoll && pairingRefreshTimer === null) {
    pairingRefreshTimer = window.setInterval(() => {
      void refreshStatus();
    }, PAIRING_REFRESH_MS);
  } else if (!shouldPoll && pairingRefreshTimer !== null) {
    window.clearInterval(pairingRefreshTimer);
    pairingRefreshTimer = null;
  }
}

async function connect(input: string): Promise<void> {
  if (state.view !== "disconnected") return;
  let baseUrl: string;
  try {
    baseUrl = normalizeUrlInput(input).origin;
  } catch {
    dispatch({ type: "connect-invalid", error: "Enter a valid Dispatch URL." });
    return;
  }
  if (usesInsecureHttp(baseUrl) && state.insecureAcknowledgedFor !== baseUrl) {
    dispatch({ type: "insecure-warning", baseUrl });
    return;
  }

  dispatch({ type: "connect-started" });
  // Safari may or may not surface a host-permission prompt here; a rejection
  // is not fatal — the background's fetch is the real access test.
  await api.permissions
    .request({
      origins: [`${new URL(baseUrl).protocol}//${new URL(baseUrl).hostname}/*`],
    })
    .catch(() => false);
  try {
    const pairing = await send<{
      code: string;
      expiresAt: string;
      verificationUrl: string;
    }>({ type: "pairing:begin", baseUrl });
    dispatch({
      type: "pairing-started",
      baseUrl,
      code: pairing.code,
      expiresAt: pairing.expiresAt,
    });
    // Opening the approval tab dismisses this popup on iPad; the background
    // keeps polling and a reopened popup resumes from pairing:status.
    await api.tabs.create({ url: pairing.verificationUrl, active: true });
  } catch (error) {
    dispatch({
      type: "pairing-failed",
      error: error instanceof Error ? error.message : "Pairing failed.",
    });
  }
}

async function cancelPairing(): Promise<void> {
  await send({ type: "pairing:cancel" }).catch(() => undefined);
  dispatch({ type: "pairing-cancelled" });
}

async function disconnect(): Promise<void> {
  await send({ type: "connection:disconnect" }).catch(() => undefined);
  dispatch({ type: "disconnected" });
}

async function selectElement(): Promise<void> {
  dispatch({ type: "arm-started" });
  try {
    await send({ type: "picker:arm" });
    dispatch({ type: "arm-succeeded" });
    window.close();
  } catch (error) {
    dispatch({
      type: "arm-failed",
      code: error instanceof RequestFailure ? error.code : undefined,
      error:
        error instanceof Error
          ? error.message
          : "The element selector could not start.",
    });
  }
}

function createNotice(
  kind: "error" | "info" | "success",
  message: string
): HTMLElement {
  const notice = document.createElement("p");
  notice.className = `status ${kind}`;
  notice.setAttribute("role", kind === "error" ? "alert" : "status");
  notice.textContent = message;
  return notice;
}

function createShell(): HTMLElement {
  const shell = document.createElement("section");
  shell.className = "shell";
  const header = document.createElement("header");
  header.className = "header";
  const title = document.createElement("h1");
  title.textContent = "Dispatch feedback";
  header.append(title);
  shell.append(header);
  return shell;
}

function renderLoading(shell: HTMLElement): void {
  const message = document.createElement("p");
  message.className = "subtle";
  message.textContent = "Loading…";
  shell.append(message);
}

function renderDisconnected(
  shell: HTMLElement,
  view: Extract<PopupState, { view: "disconnected" }>
): void {
  const intro = document.createElement("p");
  intro.className = "subtle";
  intro.textContent =
    "Connect to the Dispatch instance that manages your agents.";
  shell.append(intro);

  const form = document.createElement("form");
  form.className = "actions";
  const label = document.createElement("label");
  label.textContent = "Dispatch URL";
  const input = document.createElement("input");
  input.type = "text";
  input.inputMode = "url";
  input.autocapitalize = "off";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.placeholder = "https://dispatch.example.com";
  input.value = view.urlInput;
  input.addEventListener("input", () => {
    if (state.view === "disconnected") state.urlInput = input.value;
  });
  label.append(input);

  const connectButton = document.createElement("button");
  connectButton.type = "submit";
  connectButton.className = "primary";
  connectButton.disabled = view.busy;
  connectButton.textContent = view.busy
    ? "Connecting…"
    : view.insecureWarning
      ? "Connect anyway"
      : "Connect";
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void connect(input.value);
  });
  form.append(label, connectButton);

  if (view.insecureWarning) {
    shell.append(
      createNotice(
        "info",
        "HTTP sends pairing credentials and feedback without encryption. Continue only if you trust this network."
      )
    );
  }
  if (view.error) shell.append(createNotice("error", view.error));
  shell.append(form);
}

function renderPairing(
  shell: HTMLElement,
  view: Extract<PopupState, { view: "pairing" }>
): void {
  const code = document.createElement("p");
  code.className = "code";
  code.textContent = view.code;

  const explain = document.createElement("p");
  explain.className = "subtle";
  explain.textContent = `Approve the connection in the Dispatch tab (${view.baseUrl}) only if it shows this same code. You can close this popup — pairing continues in the background.`;

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Cancel pairing";
  cancel.addEventListener("click", () => void cancelPairing());

  if (view.error) shell.append(createNotice("error", view.error));
  shell.append(code, explain, cancel);
}

function renderConnected(
  shell: HTMLElement,
  view: Extract<PopupState, { view: "connected" }>
): void {
  const connection = document.createElement("div");
  connection.className = "connection";
  const url = document.createElement("span");
  url.className = "url";
  url.textContent = view.baseUrl;
  connection.append(url);
  if (usesInsecureHttp(view.baseUrl)) {
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = "HTTP";
    connection.append(badge);
  }

  if (view.justPaired) {
    shell.append(createNotice("success", "Browser connected to Dispatch."));
  }
  if (view.error) shell.append(createNotice("error", view.error));

  const actions = document.createElement("div");
  actions.className = "actions";
  const select = document.createElement("button");
  select.type = "button";
  select.className = "primary";
  select.disabled = view.arming;
  select.textContent = view.arming ? "Starting…" : "Select element";
  select.addEventListener("click", () => void selectElement());
  const disconnectButton = document.createElement("button");
  disconnectButton.type = "button";
  disconnectButton.textContent = "Disconnect";
  disconnectButton.addEventListener("click", () => void disconnect());
  actions.append(select, disconnectButton);

  shell.append(connection, actions);
}

function renderArmed(shell: HTMLElement): void {
  shell.append(
    createNotice(
      "success",
      "Tap an element on the page to select it. Scrolling still works while you aim."
    )
  );
}

function renderNeedsSiteAccess(
  shell: HTMLElement,
  view: Extract<PopupState, { view: "needs-site-access" }>
): void {
  shell.append(
    createNotice("info", "Dispatch Feedback needs access to this website.")
  );
  const steps = document.createElement("ol");
  steps.className = "steps";
  for (const text of [
    "Tap the extension (puzzle) button in Safari's address bar.",
    "Choose Dispatch Feedback.",
    "Allow it for this website (or always).",
    "Come back here and try again.",
  ]) {
    const step = document.createElement("li");
    step.textContent = text;
    steps.append(step);
  }
  const hint = document.createElement("p");
  hint.className = "subtle";
  hint.textContent =
    "You can also manage access in Settings → Apps → Safari → Extensions.";

  const actions = document.createElement("div");
  actions.className = "actions";
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "primary";
  retry.textContent = "Try again";
  retry.addEventListener("click", () => {
    dispatch({ type: "site-access-retry" });
    void selectElement();
  });
  actions.append(retry);

  shell.append(steps, hint, actions);
}

function render(): void {
  syncPairingRefresh();
  const shell = createShell();
  switch (state.view) {
    case "loading":
      renderLoading(shell);
      break;
    case "disconnected":
      renderDisconnected(shell, state);
      break;
    case "pairing":
      renderPairing(shell, state);
      break;
    case "connected":
      renderConnected(shell, state);
      break;
    case "armed":
      renderArmed(shell);
      break;
    case "needs-site-access":
      renderNeedsSiteAccess(shell, state);
      break;
  }
  app.replaceChildren(shell);
}

render();
void refreshStatus();
