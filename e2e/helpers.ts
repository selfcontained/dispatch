import { type Page, type APIRequestContext } from "@playwright/test";

const API = "/api/v1";
const AUTH_TOKEN = process.env.AUTH_TOKEN ?? "dev-token";

/** Return Authorization header for API requests. */
function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${AUTH_TOKEN}` };
}

/**
 * Create an agent via the REST API (faster than going through the UI every time).
 */
export async function createAgentViaAPI(
  request: APIRequestContext,
  overrides: { name?: string; type?: string; cwd?: string } = {}
): Promise<{ id: string; name: string }> {
  const res = await request.post(`${API}/agents`, {
    headers: authHeaders(),
    data: {
      name: overrides.name ?? `e2e-agent-${Date.now()}`,
      type: overrides.type ?? "codex",
      cwd: overrides.cwd ?? "/tmp",
    },
  });
  const body = (await res.json()) as { agent: { id: string; name: string } };
  return body.agent;
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

/**
 * Delete an agent via the REST API.
 */
export async function deleteAgentViaAPI(
  request: APIRequestContext,
  agentId: string
): Promise<void> {
  await request.delete(`${API}/agents/${agentId}`, { headers: authHeaders() });
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
