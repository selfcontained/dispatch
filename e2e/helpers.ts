import { type Page, type APIRequestContext } from "@playwright/test";

const API = "/api/v1";

/**
 * Create an agent via the REST API (faster than going through the UI every time).
 */
export async function createAgentViaAPI(
  request: APIRequestContext,
  overrides: { name?: string; type?: string; cwd?: string } = {}
): Promise<{ id: string; name: string }> {
  const res = await request.post(`${API}/agents`, {
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
  await request.delete(`${API}/agents/${agentId}`);
}

/**
 * Delete all agents whose name starts with `e2e-agent-` to keep the dev DB clean.
 */
export async function cleanupE2EAgents(request: APIRequestContext): Promise<void> {
  const res = await request.get(`${API}/agents`);
  const body = (await res.json()) as { agents: Array<{ id: string; name: string }> };
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
  await page.getByTestId("agent-sidebar").waitFor({ state: "visible", timeout: 15_000 });
  await page.getByTestId("status-footer").waitFor({ state: "visible", timeout: 10_000 });
}
