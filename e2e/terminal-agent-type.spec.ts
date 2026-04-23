import { test, expect } from "@playwright/test";
import {
  cleanupE2EAgents,
  loadApp,
  setEnabledAgentTypesViaAPI,
} from "./helpers";

const authHeader = {
  Authorization: `Bearer ${process.env.AUTH_TOKEN ?? "dev-token"}`,
};

type AgentRecord = {
  id: string;
  type: string;
  fullAccess: boolean;
  autoReview: boolean;
  agentArgs: string[];
  latestEvent: { type: string; message: string } | null;
};

test.describe("Terminal agent type", () => {
  // Earlier specs in the run may disable agent types via settings; re-enable
  // so these tests are order-independent.
  test.beforeEach(async ({ request }) => {
    await setEnabledAgentTypesViaAPI(request, [
      "codex",
      "claude",
      "opencode",
      "terminal",
    ]);
  });

  test.afterEach(async ({ request }) => {
    await cleanupE2EAgents(request);
  });

  test("POST /api/v1/agents accepts type=terminal and seeds an idle event", async ({
    request,
  }) => {
    const res = await request.post("/api/v1/agents", {
      headers: authHeader,
      data: {
        name: `e2e-agent-terminal-${Date.now()}`,
        type: "terminal",
        cwd: "/tmp",
        useWorktree: false,
      },
    });
    expect(res.status()).toBe(201);

    const { agent } = (await res.json()) as { agent: AgentRecord };
    expect(agent.type).toBe("terminal");
    // Created via the inert test runtime — initial event should be idle,
    // not "working" like the CLI types.
    expect(agent.latestEvent?.type).toBe("idle");
  });

  test("POST /api/v1/agents normalizes inert fields when type=terminal", async ({
    request,
  }) => {
    const res = await request.post("/api/v1/agents", {
      headers: authHeader,
      data: {
        name: `e2e-agent-terminal-${Date.now()}`,
        type: "terminal",
        cwd: "/tmp",
        useWorktree: false,
        fullAccess: true,
        autoReview: true,
        initialPrompt: "should be ignored",
      },
    });
    expect(res.status()).toBe(201);

    const { agent } = (await res.json()) as { agent: AgentRecord };
    expect(agent.fullAccess).toBe(false);
    expect(agent.autoReview).toBe(false);
    // No full-access flag should be injected for terminal.
    expect(agent.agentArgs).toEqual([]);
  });

  test("POST /api/v1/agents rejects unknown type", async ({ request }) => {
    const res = await request.post("/api/v1/agents", {
      headers: authHeader,
      data: { type: "not-a-real-type", cwd: "/tmp", useWorktree: false },
    });
    expect(res.status()).toBe(400);

    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("terminal");
  });

  test("PATCH review-agent-type rejects terminal", async ({ request }) => {
    const create = await request.post("/api/v1/agents", {
      headers: authHeader,
      data: {
        name: `e2e-agent-terminal-parent-${Date.now()}`,
        type: "codex",
        cwd: "/tmp",
        useWorktree: false,
      },
    });
    const { agent } = (await create.json()) as { agent: { id: string } };

    const patch = await request.patch(
      `/api/v1/agents/${agent.id}/review-agent-type`,
      {
        headers: authHeader,
        data: { reviewAgentType: "terminal" },
      }
    );
    expect(patch.status()).toBe(400);

    const body = (await patch.json()) as { error: string };
    expect(body.error).toContain("reviewAgentType");
  });

  test("create dialog hides inert fields when terminal is selected", async ({
    page,
  }) => {
    await loadApp(page);

    await page.getByTestId("create-agent-button").click();
    const form = page.getByTestId("create-agent-form");
    await expect(form).toBeVisible();

    // Full access + auto review + "Create with prompt" are all visible for
    // the default CLI type.
    await expect(form.getByText("Start in full access mode")).toBeVisible();
    await expect(form.getByText("Autonomous Review")).toBeVisible();
    await expect(page.getByTestId("create-agent-with-prompt")).toBeVisible();

    // Switch to terminal.
    const typeTrigger = form.getByRole("combobox").first();
    await typeTrigger.click();
    await page.getByRole("option", { name: "Terminal" }).click();
    await expect(typeTrigger).toContainText("Terminal");

    // All three inert controls should be gone; worktree checkbox stays.
    await expect(form.getByText("Start in full access mode")).not.toBeVisible();
    await expect(form.getByText("Autonomous Review")).not.toBeVisible();
    await expect(
      page.getByTestId("create-agent-with-prompt")
    ).not.toBeVisible();
    await expect(page.getByTestId("create-agent-worktree")).toBeVisible();
  });
});
