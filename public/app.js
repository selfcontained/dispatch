const state = {
  selectedAgentId: null,
  ws: null,
  agents: [],
  mediaPollTimer: null,
  shouldKeepTerminalAttached: false,
  reconnectTimer: null,
  reconnectAttempts: 0,
  activeAttachNonce: 0
};

const el = {
  health: document.querySelector("[data-health]"),
  list: document.querySelector("[data-agent-list]"),
  newAgentBtn: document.querySelector("[data-new-agent-btn]"),
  form: document.querySelector("[data-create-form]"),
  createModal: document.querySelector("[data-create-modal]"),
  createCancel: document.querySelector("[data-create-cancel]"),
  nameInput: document.querySelector("[data-create-name]"),
  cwdInput: document.querySelector("[data-create-cwd]"),
  attachBtn: document.querySelector("[data-attach-btn]"),
  detachBtn: document.querySelector("[data-detach-btn]"),
  connBadge: document.querySelector("[data-conn-badge]"),
  refreshBtn: document.querySelector("[data-refresh-btn]"),
  selected: document.querySelector("[data-selected]"),
  terminal: document.querySelector("[data-terminal-output]"),
  mediaGrid: document.querySelector("[data-media-grid]"),
  mediaRefreshBtn: document.querySelector("[data-media-refresh-btn]"),
  lightbox: document.querySelector("[data-lightbox]"),
  lightboxImage: document.querySelector("[data-lightbox-image]"),
  lightboxCaption: document.querySelector("[data-lightbox-caption]"),
  lightboxClose: document.querySelector("[data-lightbox-close]")
};

const term = new window.Terminal({
  convertEol: false,
  cursorBlink: true,
  fontFamily: "SF Mono, Menlo, monospace",
  fontSize: 13,
  scrollback: 5000,
  theme: {
    background: "#061714"
  }
});
const fitAddon = new window.FitAddon.FitAddon();
term.loadAddon(fitAddon);
term.open(el.terminal);
fitAddon.fit();

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options
  });

  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const payload = await response.json();
      if (payload?.error) {
        message = payload.error;
      }
    } catch {}
    throw new Error(message);
  }

  if (response.status === 204) {
    return null;
  }

  return await response.json();
}

function setStatus(message) {
  el.health.textContent = message;
}

function setConnectionBadge(kind) {
  el.connBadge.textContent = kind;
  el.connBadge.className = `conn-badge conn-badge--${kind}`;
}

function selectedAgent() {
  return state.agents.find((agent) => agent.id === state.selectedAgentId) ?? null;
}

function renderAgents() {
  el.list.innerHTML = "";

  for (const agent of state.agents) {
    const item = document.createElement("div");
    item.className = `agent ${state.selectedAgentId === agent.id ? "agent--active" : ""}`;
    item.title = `${agent.cwd}${agent.mediaDir ? `\nmedia: ${agent.mediaDir}` : ""}`;

    const head = document.createElement("div");
    head.className = "agent-head";
    const title = document.createElement("button");
    title.type = "button";
    title.className = "agent-title";
    title.textContent = agent.name;
    title.addEventListener("click", () => {
      state.selectedAgentId = agent.id;
      renderAgents();
      updateSelectedLabel();
      void refreshMedia();
    });

    const badge = document.createElement("span");
    badge.className = `status-pill status-pill--${agent.status}`;
    badge.textContent = agent.status;

    head.appendChild(title);
    head.appendChild(badge);

    const actions = document.createElement("div");
    actions.className = "agent-actions";

    const open = document.createElement("button");
    open.type = "button";
    open.textContent = agent.status === "running" ? "Open" : "Start";
    open.addEventListener("click", async () => {
      state.selectedAgentId = agent.id;
      renderAgents();
      updateSelectedLabel();

      if (agent.status !== "running") {
        await api(`/api/v1/agents/${agent.id}/start`, {
          method: "POST",
          body: JSON.stringify({})
        });
        await refreshAgents();
      }
      await ensureTerminalConnected(true);
      await refreshMedia();
    });

    const stop = document.createElement("button");
    stop.type = "button";
    stop.textContent = "Stop";
    stop.disabled = agent.status !== "running";
    stop.addEventListener("click", async () => {
      await api(`/api/v1/agents/${agent.id}/stop`, {
        method: "POST",
        body: JSON.stringify({ force: true })
      });
      if (state.selectedAgentId === agent.id) {
        closeSocket(false);
      }
      await refreshAgents();
      await refreshMedia();
      setStatus(`Stopped ${agent.name}.`);
    });

    const del = document.createElement("button");
    del.type = "button";
    del.className = "icon-delete";
    del.title = `Delete ${agent.name}`;
    del.textContent = "🗑";
    del.addEventListener("click", async () => {
      const confirmed = window.confirm(`Delete agent \"${agent.name}\"?`);
      if (!confirmed) return;

      if (agent.status === "running") {
        await api(`/api/v1/agents/${agent.id}/stop`, {
          method: "POST",
          body: JSON.stringify({ force: true })
        });
      }

      await api(`/api/v1/agents/${agent.id}`, { method: "DELETE" });
      if (state.selectedAgentId === agent.id) {
        state.selectedAgentId = null;
        closeSocket(false);
      }
      await refreshAgents();
      await refreshMedia();
      setStatus(`Deleted ${agent.name}.`);
    });

    actions.appendChild(open);
    actions.appendChild(stop);
    actions.appendChild(del);

    item.appendChild(head);
    item.appendChild(actions);
    el.list.appendChild(item);
  }

  if (state.selectedAgentId && !selectedAgent()) {
    state.selectedAgentId = null;
  }
}

function updateSelectedLabel() {
  const agent = selectedAgent();
  el.selected.textContent = agent
    ? `Selected: ${agent.name} (${agent.status})`
    : "Selected: none";
}

async function refreshAgents() {
  const payload = await api("/api/v1/agents");
  state.agents = payload.agents;
  renderAgents();
  updateSelectedLabel();
}

function detachTerminal() {
  state.shouldKeepTerminalAttached = false;
  clearReconnectTimer();
  closeSocket(false);
  setStatus("Terminal detached.");
  setConnectionBadge("disconnected");
}

function closeSocket(announce = true) {
  if (state.ws) {
    try {
      state.ws.close();
    } catch {}
    state.ws = null;
  }

  if (announce) {
    setStatus("Terminal disconnected.");
  }
}

function sendTerminalResize() {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    return;
  }

  state.ws.send(
    JSON.stringify({
      type: "resize",
      cols: term.cols,
      rows: term.rows
    })
  );
}

async function attachTerminal(clearScreen = true) {
  state.shouldKeepTerminalAttached = true;
  clearReconnectTimer();

  const agent = selectedAgent();
  if (!agent) {
    setStatus("Select an agent first.");
    return;
  }

  if (agent.status !== "running") {
    setStatus("Agent must be running to attach terminal.");
    return;
  }

  closeSocket(false);
  if (clearScreen) {
    term.clear();
  }

  fitAddon.fit();
  const attachNonce = ++state.activeAttachNonce;

  const tokenPayload = await api(`/api/v1/agents/${agent.id}/terminal/token`, {
    method: "POST",
    body: JSON.stringify({})
  });

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(
    `${protocol}//${window.location.host}${tokenPayload.wsUrl}&cols=${term.cols}&rows=${term.rows}`
  );
  state.ws = ws;
  setStatus(`Connecting terminal to ${agent.name}...`);

  ws.addEventListener("open", () => {
    setStatus(`Terminal connected to ${agent.name}`);
    setConnectionBadge("connected");
  });

  ws.addEventListener("message", (event) => {
    const payload = JSON.parse(event.data);
    if (payload.type === "output" && typeof payload.data === "string") {
      term.write(payload.data);
    } else if (payload.type === "error" && typeof payload.message === "string") {
      setStatus(`Terminal error: ${payload.message}`);
    } else if (payload.type === "exit") {
      setStatus("Terminal session ended.");
    }
  });

  ws.addEventListener("close", () => {
    if (state.ws !== ws) return;
    state.ws = null;
    setConnectionBadge("reconnecting");

    if (!state.shouldKeepTerminalAttached) {
      return;
    }

    if (attachNonce !== state.activeAttachNonce) {
      return;
    }

    scheduleReconnect("Terminal lost, reconnecting...");
  });
}

function clearReconnectTimer() {
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
}

function scheduleReconnect(statusMessage) {
  if (!state.shouldKeepTerminalAttached || state.reconnectTimer || state.ws) {
    return;
  }

  const agent = selectedAgent();
  if (!agent || agent.status !== "running") {
    return;
  }

  state.reconnectAttempts += 1;
  const delayMs = Math.min(1200 * state.reconnectAttempts, 8000);
  setStatus(statusMessage);
  setConnectionBadge("reconnecting");

  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    void ensureTerminalConnected(false);
  }, delayMs);
}

async function ensureTerminalConnected(clearScreen = false, userInitiated = false) {
  if (userInitiated) {
    state.shouldKeepTerminalAttached = true;
  }

  if (!state.shouldKeepTerminalAttached) {
    return;
  }

  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    sendTerminalResize();
    return;
  }

  const agent = selectedAgent();
  if (!agent || agent.status !== "running") {
    return;
  }

  try {
    await refreshAgents();
    const refreshed = selectedAgent();
    if (!refreshed || refreshed.status !== "running") {
      return;
    }

      await attachTerminal(clearScreen);
      state.reconnectAttempts = 0;
  } catch (error) {
    setStatus(`Reconnect failed: ${error.message}`);
    scheduleReconnect("Retrying terminal reconnect...");
  }
}

async function stopSelectedAgent() {
  const agent = selectedAgent();
  if (!agent) {
    setStatus("Select an agent first.");
    return;
  }

  await api(`/api/v1/agents/${agent.id}/stop`, {
    method: "POST",
    body: JSON.stringify({ force: true })
  });

  detachTerminal();
  await refreshAgents();
  await refreshMedia();
  setStatus(`Stopped ${agent.name}.`);
}

async function deleteSelectedAgent() {
  const agent = selectedAgent();
  if (!agent) {
    setStatus("Select an agent first.");
    return;
  }

  const confirmed = window.confirm(
    `Delete agent \"${agent.name}\" (${agent.id})? This removes it from Hostess.`
  );
  if (!confirmed) {
    return;
  }

  if (agent.status === "running") {
    await api(`/api/v1/agents/${agent.id}/stop`, {
      method: "POST",
      body: JSON.stringify({ force: true })
    });
  }

  await api(`/api/v1/agents/${agent.id}`, {
    method: "DELETE"
  });

  if (state.selectedAgentId === agent.id) {
    state.selectedAgentId = null;
  }
  detachTerminal();
  await refreshAgents();
  await refreshMedia();
  setStatus(`Deleted ${agent.name}.`);
}

async function createAgent(event) {
  event.preventDefault();
  const name = el.nameInput.value.trim();
  const cwd = el.cwdInput.value.trim();
  if (!cwd) {
    setStatus("Working directory is required.");
    return;
  }

  const payload = await api("/api/v1/agents", {
    method: "POST",
    body: JSON.stringify({ name, cwd })
  });

  closeCreateModal();
  await refreshAgents();
  state.selectedAgentId = payload.agent.id;
  renderAgents();
  updateSelectedLabel();
  await refreshMedia();
  await ensureTerminalConnected(true, true);
  setStatus(`Created ${payload.agent.name} and attached terminal.`);
}

async function refreshMedia() {
  const agent = selectedAgent();
  if (!agent) {
    el.mediaGrid.innerHTML = "";
    return;
  }

  try {
    const payload = await api(`/api/v1/agents/${agent.id}/media`);
    const files = payload.files ?? [];

    el.mediaGrid.innerHTML = "";
    if (files.length === 0) {
      const empty = document.createElement("div");
      empty.className = "media-meta";
      empty.textContent = "No images yet.";
      el.mediaGrid.appendChild(empty);
      return;
    }

    for (const file of files) {
      const item = document.createElement("div");
      item.className = "media-item";

      const image = document.createElement("img");
      image.src = `${file.url}?t=${encodeURIComponent(file.updatedAt)}`;
      image.alt = file.name;
      image.loading = "lazy";
      image.addEventListener("click", () => {
        openLightbox(image.src, file.name);
      });

      const meta = document.createElement("div");
      meta.className = "media-meta";
      meta.textContent = `${file.name} • ${Math.round(file.size / 1024)} KB`;

      item.appendChild(image);
      item.appendChild(meta);
      el.mediaGrid.appendChild(item);
    }
  } catch (error) {
    setStatus(`Media load error: ${error.message}`);
  }
}

function openLightbox(src, caption) {
  el.lightboxImage.src = src;
  el.lightboxCaption.textContent = caption;
  el.lightbox.hidden = false;
  document.body.style.overflow = "hidden";
}

function closeLightbox() {
  el.lightbox.hidden = true;
  el.lightboxImage.src = "";
  el.lightboxCaption.textContent = "";
  document.body.style.overflow = "";
}

function openCreateModal() {
  el.createModal.hidden = false;
  el.nameInput.focus();
}

function closeCreateModal() {
  el.createModal.hidden = true;
}

function ensureMediaPolling() {
  if (state.mediaPollTimer) {
    clearInterval(state.mediaPollTimer);
  }
  state.mediaPollTimer = setInterval(() => {
    void refreshMedia();
  }, 4000);
}

term.onData((data) => {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    return;
  }
  state.ws.send(JSON.stringify({ type: "input", data }));
});

window.addEventListener("resize", () => {
  fitAddon.fit();
  sendTerminalResize();
});

el.form.addEventListener("submit", (event) => {
  void createAgent(event);
});
el.newAgentBtn.addEventListener("click", () => {
  openCreateModal();
});
el.createCancel.addEventListener("click", () => {
  closeCreateModal();
});
el.createModal.addEventListener("click", (event) => {
  if (event.target === el.createModal) {
    closeCreateModal();
  }
});
el.attachBtn.addEventListener("click", () => {
  void ensureTerminalConnected(true, true);
});
el.detachBtn.addEventListener("click", () => {
  detachTerminal();
});
el.refreshBtn.addEventListener("click", () => {
  void refreshAgents();
});
el.mediaRefreshBtn.addEventListener("click", () => {
  void refreshMedia();
});
el.lightboxClose.addEventListener("click", () => {
  closeLightbox();
});
el.lightbox.addEventListener("click", (event) => {
  if (event.target === el.lightbox) {
    closeLightbox();
  }
});
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !el.lightbox.hidden) {
    closeLightbox();
    return;
  }
  if (event.key === "Escape" && !el.createModal.hidden) {
    closeCreateModal();
  }
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    void ensureTerminalConnected(false);
  }
});
window.addEventListener("focus", () => {
  void ensureTerminalConnected(false);
});

async function init() {
  const health = await api("/api/v1/health");
  setStatus(`API ${health.status}, DB ${health.db}`);
  await refreshAgents();
  await refreshMedia();
  ensureMediaPolling();
  el.cwdInput.value = "/Users/bharris/dev/apps/hostess";
  setConnectionBadge("disconnected");
}

void init().catch((error) => {
  setStatus(`Startup error: ${error.message}`);
});
