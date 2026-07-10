import { expect, test } from "@playwright/test";
import { cleanupE2EAgents, createAgentViaAPI } from "./helpers";

const AUTH_TOKEN = process.env.AUTH_TOKEN ?? "dev-token";

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${AUTH_TOKEN}` };
}

async function waitForAppShell(
  page: import("@playwright/test").Page,
  agentName?: string
): Promise<void> {
  await page.getByTestId("agent-sidebar").waitFor({ state: "visible" });
  await page.getByTestId("terminal-pane").waitFor({ state: "visible" });
  if (agentName) {
    await page
      .getByTestId("agent-sidebar")
      .getByText(agentName)
      .first()
      .waitFor({ state: "visible" });
  }
}

test.describe("Whiteboard", () => {
  test.afterEach(async ({ request }) => {
    await cleanupE2EAgents(request);
  });

  test("whiteboard tab renders tldraw canvas", async ({ page, request }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-agent-${Date.now()}`,
    });

    await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
    await waitForAppShell(page, agent.name);

    await page.getByTestId("center-tab-whiteboard").click();
    await expect(page).toHaveURL(new RegExp(`/agents/${agent.id}/whiteboard$`));

    await expect(page.getByTestId("whiteboard-canvas")).toBeVisible();
    // tldraw renders its canvas inside the container
    await expect(
      page.locator('[data-testid="whiteboard-canvas"] .tl-container')
    ).toBeVisible({ timeout: 10_000 });
  });

  test("whiteboard API: GET returns empty scene, PUT stores data", async ({
    request,
  }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-agent-${Date.now()}`,
    });

    // GET should return empty scene
    const getRes = await request.get(`/api/v1/agents/${agent.id}/whiteboard`, {
      headers: authHeaders(),
    });
    expect(getRes.ok()).toBe(true);
    const getData = (await getRes.json()) as {
      scene: { records: unknown[] };
      version: number;
    };
    expect(getData.version).toBe(0);
    expect(getData.scene.records).toEqual([]);

    // PUT with ops
    const putRes = await request.put(`/api/v1/agents/${agent.id}/whiteboard`, {
      headers: authHeaders(),
      data: {
        ops: [
          {
            op: "add",
            type: "rect",
            id: "e2e-rect-1",
            x: 10,
            y: 20,
            w: 100,
            h: 50,
            label: "E2E Box",
          },
        ],
      },
    });
    expect(putRes.ok()).toBe(true);
    const putData = (await putRes.json()) as {
      version: number;
      elementCount: number;
    };
    expect(putData.version).toBe(1);
    expect(putData.elementCount).toBe(1);

    // GET again should return the shape
    const getRes2 = await request.get(`/api/v1/agents/${agent.id}/whiteboard`, {
      headers: authHeaders(),
    });
    const getData2 = (await getRes2.json()) as {
      scene: { records: unknown[] };
      version: number;
      elements: Array<{ id: string; type: string }>;
    };
    expect(getData2.version).toBe(1);
    expect(getData2.scene.records.length).toBe(1);
    expect(getData2.elements.length).toBe(1);
  });

  test("whiteboard deep-link route renders canvas", async ({
    page,
    request,
  }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-agent-${Date.now()}`,
    });

    await page.goto(`/agents/${agent.id}/whiteboard`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByTestId("agent-sidebar").waitFor({ state: "visible" });
    await page
      .getByTestId("agent-sidebar")
      .getByText(agent.name)
      .first()
      .waitFor({ state: "visible" });

    await expect(page.getByTestId("whiteboard-canvas")).toBeVisible();
  });
});
