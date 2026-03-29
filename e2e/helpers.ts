import { type Page, type APIRequestContext } from "@playwright/test";

const API = "/api/v1";
const AUTH_TOKEN = process.env.AUTH_TOKEN ?? "dev-token";

/** Return Authorization header for API requests. */
function authHeaders(): Record<string, string> {
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

/**
 * Create an agent via the REST API (faster than going through the UI every time).
 * When useWorktree is true, polls until the setup script completes (status transitions
 * from 'creating' to 'running') so the worktree fields are populated.
 */
export async function createAgentViaAPI(
  request: APIRequestContext,
  overrides: { name?: string; type?: string; cwd?: string; useWorktree?: boolean; worktreeBranch?: string } = {}
): Promise<AgentResult> {
  const res = await request.post(`${API}/agents`, {
    headers: authHeaders(),
    data: {
      name: overrides.name ?? `e2e-agent-${Date.now()}`,
      type: overrides.type ?? "codex",
      cwd: overrides.cwd ?? "/tmp",
      useWorktree: overrides.useWorktree ?? false,
      worktreeBranch: overrides.worktreeBranch,
    },
  });
  const body = (await res.json()) as { agent: AgentResult };
  let agent = body.agent;

  // When using worktrees, the setup runs asynchronously in tmux.
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
): Promise<{ hasWorktree: boolean; hasUnmergedCommits: boolean; worktreePath: string | null; branchName: string | null; changedFiles: string[] }> {
  const res = await request.get(`${API}/agents/${agentId}/worktree-status`, {
    headers: authHeaders(),
  });
  return (await res.json()) as { hasWorktree: boolean; hasUnmergedCommits: boolean; worktreePath: string | null; branchName: string | null; changedFiles: string[] };
}

export async function setAgentLatestEventViaAPI(
  request: APIRequestContext,
  agentId: string,
  event: { type: "working" | "blocked" | "waiting_user" | "done" | "idle"; message: string }
): Promise<void> {
  await request.post(`${API}/agents/${agentId}/latest-event`, {
    headers: authHeaders(),
    data: event
  });
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

export async function uploadMediaViaAPI(
  request: APIRequestContext,
  agentId: string,
  description: string,
  fileName = `media-${Date.now()}.png`
): Promise<void> {
  const pngBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9VE3D7wAAAAASUVORK5CYII=",
    "base64"
  );

  const res = await request.post(`${API}/agents/${agentId}/media`, {
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
    throw new Error(`Media upload failed with ${res.status()}`);
  }
}

/**
 * Delete an agent via the REST API (force-stops and cleans up worktrees).
 */
export async function deleteAgentViaAPI(
  request: APIRequestContext,
  agentId: string,
  cleanupWorktree: "auto" | "keep" | "force" = "force"
): Promise<void> {
  await request.post(`${API}/agents/${agentId}/stop`, {
    headers: authHeaders(),
    data: { force: true },
  }).catch(() => {});
  await request.delete(`${API}/agents/${agentId}?force=true&cleanupWorktree=${cleanupWorktree}`, {
    headers: authHeaders(),
  });
}

/**
 * Delete all agents whose name starts with `e2e-agent-` to keep the dev DB clean.
 */
export async function cleanupE2EAgents(request: APIRequestContext): Promise<void> {
  const res = await request.get(`${API}/agents`, { headers: authHeaders() });
  const body = (await res.json()) as { agents?: Array<{ id: string; name: string }> };
  if (!body.agents) return;
  for (const agent of body.agents) {
    if (agent.name.startsWith("e2e-agent-")) {
      await deleteAgentViaAPI(request, agent.id);
    }
  }
}

export async function seedActivityDemoViaAPI(request: APIRequestContext): Promise<void> {
  const res = await request.post(`${API}/activity/demo-seed`, {
    headers: authHeaders(),
  });

  if (!res.ok()) {
    throw new Error(`Activity demo seed failed with ${res.status()}`);
  }
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
    sidebar.waitFor({ state: "visible", timeout: 15_000 }).catch(() => null)
  ]);

  // If login page is showing, that's unexpected in e2e (fresh DB = no password).
  // But handle it gracefully just in case.
  if (await loginInput.isVisible().catch(() => false)) {
    throw new Error("Unexpected login page in e2e test — DB should have no password set.");
  }

  await sidebar.waitFor({ state: "visible", timeout: 15_000 });
  await page.getByTestId("status-footer").waitFor({ state: "visible", timeout: 10_000 });
}
