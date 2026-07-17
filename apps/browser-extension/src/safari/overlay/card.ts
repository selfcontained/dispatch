import type {
  BrowserSelection,
  OverlayInitData,
  SafariRequest,
  WorkerRequest,
} from "../../types";

const COMMENT_MAX_LENGTH = 10_000;
const SENT_DISMISS_MS = 1_200;

export interface CardDeps {
  /** Rejects with an Error whose `terminal` property is true when a retry
   * must use a fresh clientSubmissionId. */
  send<T>(request: WorkerRequest | SafariRequest): Promise<T>;
  origin: string;
  selection: BrowserSelection;
  selectorLabel: string;
  onReselect(): void;
  onCancel(): void;
  onSubmitted(): void;
}

interface CardState {
  loading: boolean;
  connected: boolean;
  agents: OverlayInitData["agents"];
  selectedAgentId: string;
  comment: string;
  busy: boolean;
  sent: boolean;
  error: string | null;
}

export interface CardHandle {
  destroy(): void;
}

export function mountCard(container: HTMLElement, deps: CardDeps): CardHandle {
  let destroyed = false;
  let sentTimer: number | null = null;
  let pendingSubmission: {
    id: string;
    agentId: string;
    comment: string;
    selection: BrowserSelection;
  } | null = null;

  const state: CardState = {
    loading: true,
    connected: false,
    agents: [],
    selectedAgentId: "",
    comment: "",
    busy: false,
    sent: false,
    error: null,
  };

  async function init(): Promise<void> {
    try {
      const data = await deps.send<OverlayInitData>({
        type: "overlay:init",
        origin: deps.origin,
      });
      if (destroyed) return;
      state.loading = false;
      state.connected = data.connected;
      state.agents = data.agents;
      state.selectedAgentId = data.selectedAgentId ?? data.agents[0]?.id ?? "";
    } catch (error) {
      if (destroyed) return;
      state.loading = false;
      state.connected = false;
      state.error =
        error instanceof Error ? error.message : "Extension request failed.";
    }
    render();
  }

  async function submit(): Promise<void> {
    const comment = state.comment.trim();
    if (!comment || !state.selectedAgentId || state.busy) return;
    if (
      !pendingSubmission ||
      pendingSubmission.agentId !== state.selectedAgentId ||
      pendingSubmission.comment !== comment ||
      pendingSubmission.selection !== deps.selection
    ) {
      pendingSubmission = {
        id: crypto.randomUUID(),
        agentId: state.selectedAgentId,
        comment,
        selection: deps.selection,
      };
    }
    state.busy = true;
    state.error = null;
    render();
    try {
      await deps.send({
        type: "submission:create",
        clientSubmissionId: pendingSubmission.id,
        agentId: pendingSubmission.agentId,
        comment: pendingSubmission.comment,
        selection: pendingSubmission.selection,
      });
      if (destroyed) return;
      pendingSubmission = null;
      state.busy = false;
      state.sent = true;
      render();
      sentTimer = window.setTimeout(() => {
        deps.onSubmitted();
      }, SENT_DISMISS_MS);
    } catch (error) {
      if (destroyed) return;
      if (
        error instanceof Error &&
        "terminal" in error &&
        (error as Error & { terminal?: boolean }).terminal
      ) {
        pendingSubmission = null;
      }
      state.busy = false;
      state.error =
        error instanceof Error ? error.message : "Feedback could not be sent.";
      render();
    }
  }

  function render(): void {
    container.replaceChildren();
    container.classList.add("card");

    if (state.sent) {
      const sent = document.createElement("p");
      sent.className = "card-sent";
      sent.textContent = "Sent ✓";
      container.append(sent);
      return;
    }

    const summary = document.createElement("div");
    summary.className = "card-summary";
    const selector = document.createElement("code");
    selector.className = "card-selector";
    selector.textContent = deps.selectorLabel;
    const reselect = document.createElement("button");
    reselect.type = "button";
    reselect.className = "card-button subtle-button";
    reselect.textContent = "Reselect";
    reselect.disabled = state.busy;
    reselect.addEventListener("click", deps.onReselect);
    summary.append(selector, reselect);
    container.append(summary);

    if (state.loading) {
      const loading = document.createElement("p");
      loading.className = "card-note";
      loading.textContent = "Loading agents…";
      container.append(loading);
      return;
    }

    if (!state.connected) {
      const note = document.createElement("p");
      note.className = "card-note";
      note.textContent =
        state.error ??
        "Not connected to Dispatch. Open the Dispatch Feedback extension to connect.";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "card-button";
      cancel.textContent = "Close";
      cancel.addEventListener("click", deps.onCancel);
      container.append(note, cancel);
      return;
    }

    const form = document.createElement("form");
    form.className = "card-form";
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void submit();
    });

    const agentLabel = document.createElement("label");
    agentLabel.className = "card-label";
    agentLabel.textContent = "Agent";
    const agentSelect = document.createElement("select");
    agentSelect.className = "card-select";
    agentSelect.disabled = state.busy || state.agents.length === 0;
    if (state.agents.length === 0) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "No running agents";
      agentSelect.append(option);
    }
    for (const agent of state.agents) {
      const option = document.createElement("option");
      option.value = agent.id;
      option.textContent = agent.repoName
        ? `${agent.name} · ${agent.repoName}`
        : agent.name;
      option.selected = agent.id === state.selectedAgentId;
      agentSelect.append(option);
    }
    agentSelect.addEventListener("change", () => {
      state.selectedAgentId = agentSelect.value;
      void deps
        .send({
          type: "agent:remember",
          origin: deps.origin,
          agentId: agentSelect.value,
        })
        .catch(() => undefined);
    });
    agentLabel.append(agentSelect);

    const commentLabel = document.createElement("label");
    commentLabel.className = "card-label";
    commentLabel.textContent = "Comment";
    const textarea = document.createElement("textarea");
    textarea.className = "card-textarea";
    textarea.maxLength = COMMENT_MAX_LENGTH;
    textarea.placeholder = "What should the agent know about this element?";
    textarea.value = state.comment;
    textarea.disabled = state.busy;
    textarea.addEventListener("input", () => {
      state.comment = textarea.value;
      updateSendEnabled();
    });
    commentLabel.append(textarea);

    const errorSlot = document.createElement("p");
    errorSlot.className = "card-error";
    if (state.error) errorSlot.textContent = state.error;
    errorSlot.hidden = !state.error;

    const actions = document.createElement("div");
    actions.className = "card-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "card-button";
    cancel.textContent = "Cancel";
    cancel.disabled = state.busy;
    cancel.addEventListener("click", deps.onCancel);
    const send = document.createElement("button");
    send.type = "submit";
    send.className = "card-button primary-button";
    send.textContent = state.busy ? "Sending…" : "Send";
    actions.append(cancel, send);

    function updateSendEnabled(): void {
      send.disabled =
        state.busy || !state.comment.trim() || !state.selectedAgentId;
    }
    updateSendEnabled();

    form.append(agentLabel, commentLabel, errorSlot, actions);
    container.append(form);
    if (!state.busy) textarea.focus({ preventScroll: true });
  }

  render();
  void init();

  return {
    destroy(): void {
      destroyed = true;
      if (sentTimer !== null) window.clearTimeout(sentTimer);
      container.replaceChildren();
    },
  };
}
