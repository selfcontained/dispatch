import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { type Page, type APIRequestContext } from "@playwright/test";

const API = "/api/v1";
const AUTH_TOKEN = process.env.AUTH_TOKEN ?? "dev-token";

const trackedAgentIds = new Set<string>();

/**
 * Click an agent row to attach/focus it. Clicks the icon area (left edge)
 * to avoid hitting the session name button which opens the settings dialog.
 */
export async function clickAgentRow(
  page: Page,
  agentId: string
): Promise<void> {
  await page
    .getByTestId(`agent-row-${agentId}`)
    .click({ position: { x: 4, y: 8 } });
}

/** Register an agent ID for cleanup — use when creating agents outside createAgentViaAPI. */
export function trackAgent(id: string): void {
  trackedAgentIds.add(id);
}

/** Return Authorization header for API requests. */
export function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${AUTH_TOKEN}` };
}

type AgentResult = {
  id: string;
  name: string;
  status: string;
  cwd: string;
  worktreePath: string | null;
  worktreeBranch: string | null;
};

export async function createAgentViaAPI(
  request: APIRequestContext,
  overrides: {
    name?: string;
    type?: string;
    cwd?: string;
    useWorktree?: boolean;
    fullAccess?: boolean;
    worktreeBranch?: string;
    /** Launch as a child of this agent (renders as a sub agent row). */
    parentAgentId?: string;
  } = {}
): Promise<AgentResult> {
  const res = await request.post(`${API}/agents`, {
    headers: authHeaders(),
    data: {
      name: overrides.name ?? `e2e-agent-${Date.now()}`,
      type: overrides.type ?? "codex",
      cwd: overrides.cwd ?? "/tmp",
      useWorktree: overrides.useWorktree ?? false,
      ...(overrides.fullAccess !== undefined
        ? { fullAccess: overrides.fullAccess }
        : {}),
      worktreeBranch: overrides.worktreeBranch,
      parentAgentId: overrides.parentAgentId,
    },
  });
  const body = (await res.json()) as { agent: AgentResult };
  let agent = body.agent;
  trackedAgentIds.add(agent.id);

  // When using worktrees, workspace preparation runs asynchronously.
  // Poll until the agent transitions to 'running' (setup complete).
  if (overrides.useWorktree && agent.status === "creating") {
    const deadline = Date.now() + 60_000;
    while (agent.status === "creating" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      const poll = await request.get(`${API}/agents/${agent.id}`, {
        headers: authHeaders(),
      });
      const pollBody = (await poll.json()) as { agent: AgentResult };
      agent = pollBody.agent;
    }
    if (agent.status === "creating") {
      throw new Error(`Agent ${agent.id} setup did not complete within 60s`);
    }
  }

  return agent;
}

export async function getWorktreeStatusViaAPI(
  request: APIRequestContext,
  agentId: string
): Promise<{
  hasWorktree: boolean;
  hasUnmergedCommits: boolean;
  worktreePath: string | null;
  branchName: string | null;
  changedFiles: string[];
}> {
  const res = await request.get(`${API}/agents/${agentId}/worktree-status`, {
    headers: authHeaders(),
  });
  return (await res.json()) as {
    hasWorktree: boolean;
    hasUnmergedCommits: boolean;
    worktreePath: string | null;
    branchName: string | null;
    changedFiles: string[];
  };
}

export async function setEnabledAgentTypesViaAPI(
  request: APIRequestContext,
  enabledAgentTypes: string[]
): Promise<void> {
  const res = await request.post(`${API}/app/settings/agent-types`, {
    headers: authHeaders(),
    data: { enabledAgentTypes },
  });

  if (!res.ok()) {
    throw new Error(`Failed to update agent type settings: ${res.status()}`);
  }
}

export async function uploadFileViaAPI(
  request: APIRequestContext,
  agentId: string,
  description: string,
  fileName = `file-${Date.now()}.png`
): Promise<void> {
  const pngBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9VE3D7wAAAAASUVORK5CYII=",
    "base64"
  );

  const res = await request.post(`${API}/agents/${agentId}/files`, {
    headers: authHeaders(),
    multipart: {
      description,
      source: "screenshot",
      file: {
        name: fileName,
        mimeType: "image/png",
        buffer: pngBytes,
      },
    },
  });

  if (!res.ok()) {
    throw new Error(`File upload failed with ${res.status()}`);
  }
}

export async function uploadTextFileViaAPI(
  request: APIRequestContext,
  agentId: string,
  description: string,
  content: string,
  fileName = `file-${Date.now()}.md`,
  mimeType = "text/markdown"
): Promise<void> {
  const res = await request.post(`${API}/agents/${agentId}/files`, {
    headers: authHeaders(),
    multipart: {
      description,
      source: "text",
      file: {
        name: fileName,
        mimeType,
        buffer: Buffer.from(content, "utf8"),
      },
    },
  });

  if (!res.ok()) {
    throw new Error(`File upload failed with ${res.status()}`);
  }
}

export async function setAgentRoleViaDB(
  agentId: string,
  role: "standard" | "assisted_update"
): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required to seed agent roles.");
  }

  const pool = new Pool({ connectionString, max: 1 });
  try {
    await pool.query(
      "UPDATE agents SET role = $2, updated_at = NOW() WHERE id = $1",
      [agentId, role]
    );
  } finally {
    await pool.end();
  }
}

/**
 * Insert a block straight into `blocks`, bypassing the send route (which
 * needs a live agent). `streamId` is the root agent; the author defaults
 * to that agent (or the user, addressed to it). Attachments use the stored
 * shape; `data` and `state` are the kind's own.
 */
export async function seedBlockViaDB(input: {
  streamId: string;
  authorKind: "user" | "agent";
  authorAgentId?: string;
  toAgentId?: string | null;
  kind?: "text" | "question" | "form" | "file" | "link" | "review" | "tasks";
  text?: string;
  data?: unknown;
  state?: unknown;
  attachments?: unknown[];
  delivered?: boolean | null;
}): Promise<string> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required to seed blocks.");
  }
  const id = randomUUID();
  const authorAgentId =
    input.authorKind === "agent"
      ? (input.authorAgentId ?? input.streamId)
      : null;
  const toAgentId =
    input.toAgentId !== undefined
      ? input.toAgentId
      : input.authorKind === "user"
        ? input.streamId
        : null;
  const pool = new Pool({ connectionString, max: 1 });
  try {
    await pool.query(
      `INSERT INTO blocks
         (id, stream_id, author_kind, author_agent_id, to_agent_id, kind, text,
          data, state, attachments, delivered)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11)`,
      [
        id,
        input.streamId,
        input.authorKind,
        authorAgentId,
        toAgentId,
        input.kind ?? "text",
        input.text ?? "",
        input.data === undefined ? null : JSON.stringify(input.data),
        input.state === undefined ? null : JSON.stringify(input.state),
        JSON.stringify(input.attachments ?? []),
        input.delivered ?? null,
      ]
    );
  } finally {
    await pool.end();
  }
  return id;
}

/** A text block, as `seedBlockViaDB` with the text kind. */
export async function seedChatMessageViaDB(message: {
  agentId: string;
  authorKind: "user" | "agent";
  text: string;
  attachments?: unknown[];
  delivered?: boolean | null;
}): Promise<string> {
  return seedBlockViaDB({
    streamId: message.agentId,
    authorKind: message.authorKind,
    text: message.text,
    attachments: message.attachments,
    delivered: message.delivered,
  });
}

/** Calls an MCP tool the way an agent would, through its per-agent endpoint. */
export async function callMcpToolViaAPI(
  request: APIRequestContext,
  agentId: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const res = await request.fetch(`/api/mcp/${agentId}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    data: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    },
  });
  const text = await res.text();
  const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
  if (!dataLine) throw new Error(`No data line in MCP response: ${text}`);
  const payload = JSON.parse(dataLine.slice("data: ".length)) as {
    result?: { isError?: boolean; content?: Array<{ text?: string }> };
    error?: unknown;
  };
  if (payload.error || payload.result?.isError) {
    throw new Error(`MCP ${toolName} failed: ${text}`);
  }
  return payload as Record<string, unknown>;
}

/**
 * Delete an agent via the REST API (force-stops and cleans up worktrees).
 */
export async function deleteAgentViaAPI(
  request: APIRequestContext,
  agentId: string,
  cleanupWorktree: "auto" | "keep" | "force" = "force"
): Promise<void> {
  await request
    .post(`${API}/agents/${agentId}/stop`, {
      headers: authHeaders(),
      data: { force: true },
    })
    .catch(() => {});
  await request.delete(
    `${API}/agents/${agentId}?force=true&cleanupWorktree=${cleanupWorktree}`,
    {
      headers: authHeaders(),
    }
  );
  // Archive is async — poll until the agent is actually gone
  for (let i = 0; i < 50; i++) {
    try {
      const res = await request.get(`${API}/agents/${agentId}`, {
        headers: authHeaders(),
      });
      if (res.status() === 404) return;
    } catch {
      // The isolated API server can briefly drop connections during teardown.
      // Treat that as retryable instead of failing the whole suite cleanup.
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * Clean up agents created during tests.
 *
 * Default ("tracked") mode only deletes agents created by `createAgentViaAPI`
 * in this worker process — safe to call from parallel workers.
 *
 * Pass "all" to delete every `e2e-agent-*` agent and its children.
 * Only use "all" from tests that run with a single worker (serial suite).
 */
export async function cleanupE2EAgents(
  request: APIRequestContext,
  mode: "tracked" | "all" = "tracked"
): Promise<void> {
  if (mode === "tracked") {
    const ids = [...trackedAgentIds];
    trackedAgentIds.clear();
    // Also delete sub-agents (e.g. persona reviewers)
    if (ids.length > 0) {
      const res = await request.get(`${API}/agents`, {
        headers: authHeaders(),
      });
      const body = (await res.json()) as {
        agents?: Array<{
          id: string;
          name: string;
          parentAgentId?: string | null;
        }>;
      };
      const parentSet = new Set(ids);
      const toDelete = new Set(ids);
      for (const agent of body.agents ?? []) {
        if (agent.parentAgentId && parentSet.has(agent.parentAgentId)) {
          toDelete.add(agent.id);
        }
      }
      await Promise.all(
        [...toDelete].map((id) => deleteAgentViaAPI(request, id))
      );
    }
    return;
  }

  const res = await request.get(`${API}/agents`, { headers: authHeaders() });
  const body = (await res.json()) as {
    agents?: Array<{ id: string; name: string; parentAgentId?: string | null }>;
  };
  if (!body.agents) return;
  const parentIds = new Set(
    body.agents
      .filter((agent) => agent.name.startsWith("e2e-agent-"))
      .map((agent) => agent.id)
  );
  const toDelete = body.agents.filter(
    (agent) =>
      agent.name.startsWith("e2e-agent-") ||
      (agent.parentAgentId && parentIds.has(agent.parentAgentId))
  );
  await Promise.all(
    toDelete.map((agent) => deleteAgentViaAPI(request, agent.id))
  );
  trackedAgentIds.clear();
}

/**
 * Navigate to the app root and wait for the shell to be ready
 * (sidebar rendered + health polling started).
 */
export async function loadApp(page: Page): Promise<void> {
  await page.goto("/", { waitUntil: "domcontentloaded" });

  // On a fresh DB with no password, the app loads directly.
  // If a password is set and user isn't authenticated, the login page shows.
  const loginInput = page.getByTestId("login-password");
  const sidebar = page.getByTestId("agent-sidebar");

  await Promise.race([
    loginInput.waitFor({ state: "visible", timeout: 15_000 }).catch(() => null),
    sidebar.waitFor({ state: "visible", timeout: 15_000 }).catch(() => null),
  ]);

  // If login page is showing, that's unexpected in e2e (fresh DB = no password).
  // But handle it gracefully just in case.
  if (await loginInput.isVisible().catch(() => false)) {
    throw new Error(
      "Unexpected login page in e2e test — DB should have no password set."
    );
  }

  await sidebar.waitFor({ state: "visible", timeout: 15_000 });
  await page
    .getByTestId("chat-pane")
    .waitFor({ state: "visible", timeout: 10_000 });
}
