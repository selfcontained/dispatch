import { test, expect } from "@playwright/test";
import {
  cleanupE2EAgents,
  clickAgentRow,
  createAgentViaAPI,
  loadApp,
} from "./helpers";

const AUTH_HEADER = {
  Authorization: `Bearer ${process.env.AUTH_TOKEN ?? "dev-token"}`,
};

async function callMcpTool(
  request: Parameters<Parameters<typeof test>[1]>[0]["request"],
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
  return JSON.parse(dataLine.slice("data: ".length)) as Record<string, unknown>;
}

test.describe("Whiteboard", () => {
  test.afterEach(async ({ request }) => {
    await cleanupE2EAgents(request);
  });

  test("whiteboard tab is visible and navigates", async ({ page, request }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-agent-wb-${Date.now()}`,
    });
    await loadApp(page);
    await clickAgentRow(page, agent.id);

    const wbTab = page.getByTestId("center-tab-whiteboard");
    await expect(wbTab).toBeVisible();
    await wbTab.click();

    await page.waitForURL(/\/agents\/[^/]+\/whiteboard/);
  });

  test("whiteboard REST API: PUT persists and GET retrieves scene", async ({
    request,
  }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-agent-wb-api-${Date.now()}`,
    });

    // GET should return empty scene initially
    const getRes1 = await request.get(`/api/v1/agents/${agent.id}/whiteboard`, {
      headers: AUTH_HEADER,
    });
    expect(getRes1.ok()).toBe(true);
    const data1 = (await getRes1.json()) as {
      scene: { elements: unknown[] };
      version: number;
    };
    expect(data1.scene.elements).toEqual([]);
    expect(data1.version).toBe(0);

    // PUT a scene
    const scene = {
      elements: [
        {
          id: "test-box",
          type: "rectangle",
          x: 100,
          y: 100,
          width: 160,
          height: 70,
        },
      ],
    };
    const putRes = await request.put(`/api/v1/agents/${agent.id}/whiteboard`, {
      headers: { ...AUTH_HEADER, "content-type": "application/json" },
      data: { scene, baseVersion: 0 },
    });
    expect(putRes.ok()).toBe(true);
    const putData = (await putRes.json()) as { ok: boolean; version: number };
    expect(putData.ok).toBe(true);
    expect(putData.version).toBe(1);

    // GET should now return the scene
    const getRes2 = await request.get(`/api/v1/agents/${agent.id}/whiteboard`, {
      headers: AUTH_HEADER,
    });
    const data2 = (await getRes2.json()) as {
      scene: { elements: unknown[] };
      version: number;
    };
    expect(data2.scene.elements).toHaveLength(1);
    expect((data2.scene.elements[0] as { id: string }).id).toBe("test-box");
    expect(data2.version).toBe(1);
  });

  test("whiteboard REST API: PUT rejects stale baseVersion with 409", async ({
    request,
  }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-agent-wb-conflict-${Date.now()}`,
    });

    const scene = {
      elements: [
        { id: "a", type: "rectangle", x: 0, y: 0, width: 100, height: 50 },
      ],
    };

    // First PUT succeeds
    const putRes1 = await request.put(`/api/v1/agents/${agent.id}/whiteboard`, {
      headers: { ...AUTH_HEADER, "content-type": "application/json" },
      data: { scene, baseVersion: 0 },
    });
    expect(putRes1.ok()).toBe(true);

    // Second PUT with stale baseVersion=0 should get 409
    const putRes2 = await request.put(`/api/v1/agents/${agent.id}/whiteboard`, {
      headers: { ...AUTH_HEADER, "content-type": "application/json" },
      data: { scene, baseVersion: 0 },
    });
    expect(putRes2.status()).toBe(409);
    const conflictData = (await putRes2.json()) as {
      error: string;
      version: number;
    };
    expect(conflictData.error).toContain("modified");
    expect(conflictData.version).toBe(1);
  });

  test("whiteboard MCP tool: agent can update and read whiteboard", async ({
    request,
  }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-agent-wb-mcp-${Date.now()}`,
    });

    // Call whiteboard_update via MCP
    const updateJson = await callMcpTool(
      request,
      agent.id,
      "whiteboard_update",
      {
        elements: [
          {
            id: "api-box",
            type: "rectangle",
            x: 100,
            y: 100,
            width: 160,
            height: 70,
            backgroundColor: "#a5d8ff",
          },
          {
            id: "api-label",
            type: "text",
            x: 110,
            y: 120,
            width: 140,
            height: 25,
            text: "API Server",
            originalText: "API Server",
            containerId: "api-box",
          },
        ],
      }
    );

    const updateResult = updateJson.result as {
      content?: Array<{ text?: string }>;
    };
    const updateContent = JSON.parse(
      updateResult?.content?.[0]?.text ?? "{}"
    ) as {
      ok: boolean;
      addedIds: string[];
      elementCount: number;
    };
    expect(updateContent.ok).toBe(true);
    expect(updateContent.addedIds).toEqual(["api-box", "api-label"]);
    expect(updateContent.elementCount).toBe(2);

    // Call whiteboard_get via MCP
    const getJson = await callMcpTool(request, agent.id, "whiteboard_get", {});
    const getResult = getJson.result as {
      structuredContent?: {
        elementCount: number;
        elements: Array<{ id: string }>;
      };
    };
    expect(getResult?.structuredContent?.elementCount).toBe(2);
    expect(
      getResult?.structuredContent?.elements?.map((e) => e.id).sort()
    ).toEqual(["api-box", "api-label"]);

    // Call whiteboard_clear via MCP
    const clearJson = await callMcpTool(
      request,
      agent.id,
      "whiteboard_clear",
      {}
    );
    const clearResult = clearJson.result as {
      content?: Array<{ text?: string }>;
    };
    expect(clearResult?.content?.[0]?.text).toContain("ok");

    // Verify board is empty via REST
    const getRes2 = await request.get(`/api/v1/agents/${agent.id}/whiteboard`, {
      headers: AUTH_HEADER,
    });
    const data2 = (await getRes2.json()) as {
      scene: { elements: unknown[] };
    };
    expect(data2.scene.elements).toEqual([]);
  });
});
