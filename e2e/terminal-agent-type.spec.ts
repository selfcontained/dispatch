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

async function stubClipboard(
  page: Parameters<typeof loadApp>[0],
  config:
    | { kind: "text"; text: string }
    | { kind: "deferred-text"; firstText: string; nextText: string }
    | { kind: "blocked" }
    | { kind: "unsupported" }
    | { kind: "rich-text-link"; text: string; html: string }
    | { kind: "image"; mimeType?: string; bytes?: number[] }
): Promise<void> {
  await page.addInitScript((value) => {
    const clipboard =
      value.kind === "image"
        ? {
            read: async () => [
              {
                types: [value.mimeType ?? "image/png"],
                getType: async (type: string) =>
                  new Blob([new Uint8Array(value.bytes ?? [137, 80, 78, 71])], {
                    type,
                  }),
              },
            ],
            readText: async () => "",
          }
        : value.kind === "rich-text-link"
          ? {
              read: async () => [
                {
                  types: ["text/html", "text/plain"],
                  getType: async (type: string) =>
                    new Blob([type === "text/html" ? value.html : value.text], {
                      type,
                    }),
                },
              ],
              readText: async () => value.text,
            }
          : value.kind === "deferred-text"
            ? {
                read: async () => [],
                readText: async () => {
                  const current =
                    window.__dispatchClipboardText ?? value.firstText;
                  window.__dispatchClipboardText = value.nextText;
                  return current;
                },
              }
            : value.kind === "blocked"
              ? {
                  read: async () => {
                    throw new DOMException("Blocked", "NotAllowedError");
                  },
                  readText: async () => {
                    throw new DOMException("Blocked", "NotAllowedError");
                  },
                }
              : value.kind === "unsupported"
                ? undefined
                : {
                    read: async () => [],
                    readText: async () => value.text,
                  };

    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: clipboard,
    });
  }, config);
}

declare global {
  interface Window {
    __dispatchClipboardText?: string;
  }
}

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

    // Full access + auto review + "Create with context" are all visible for
    // the default CLI type.
    await expect(form.getByText("Start in full access mode")).toBeVisible();
    await expect(form.getByText("Autonomous Review")).toBeVisible();
    await expect(page.getByTestId("create-agent-with-context")).toBeVisible();

    // Switch to terminal.
    const typeTrigger = form.getByRole("combobox").first();
    await typeTrigger.click();
    await page.getByRole("option", { name: "Terminal" }).click();
    await expect(typeTrigger).toContainText("Terminal");

    // All three inert controls should be gone; worktree checkbox stays.
    await expect(form.getByText("Start in full access mode")).not.toBeVisible();
    await expect(form.getByText("Autonomous Review")).not.toBeVisible();
    await expect(
      page.getByTestId("create-agent-with-context")
    ).not.toBeVisible();
    await expect(page.getByTestId("create-agent-worktree")).toBeVisible();
  });

  test("create with context shows instructions, files, and links", async ({
    page,
  }) => {
    await loadApp(page);

    await page.getByTestId("create-agent-button").click();
    await page.getByTestId("create-agent-with-context").click();

    await expect(page.getByText("Create with context")).toBeVisible();
    await expect(page.getByTestId("create-agent-initial-prompt")).toBeVisible();
    await expect(
      page.getByTestId("create-agent-context-files-button")
    ).toBeVisible();
    await expect(
      page.getByTestId("create-agent-context-link-input")
    ).toBeVisible();
  });

  test("create with context suggests a copied link without auto-attaching it", async ({
    page,
  }) => {
    await stubClipboard(page, {
      kind: "text",
      text: "https://example.com/docs/launch-context",
    });
    await loadApp(page);

    await page.getByTestId("create-agent-button").click();
    await page.getByTestId("create-agent-with-context").click();

    const cta = page.getByTestId("create-agent-context-clipboard-cta");
    await expect(cta).toContainText("Copied link ready");
    await expect(
      page.getByText("No links added yet.", { exact: true })
    ).toBeVisible();

    await page.getByTestId("create-agent-context-clipboard-action").click();

    await expect(
      page.getByText("https://example.com/docs/launch-context")
    ).toBeVisible();
    await expect(cta).not.toBeVisible();
  });

  test("create with context treats rich-text links as links, not files", async ({
    page,
  }) => {
    await stubClipboard(page, {
      kind: "rich-text-link",
      text: "https://example.com/rich-link",
      html: '<a href="https://example.com/rich-link">Example</a>',
    });
    await loadApp(page);

    await page.getByTestId("create-agent-button").click();
    await page.getByTestId("create-agent-with-context").click();

    const cta = page.getByTestId("create-agent-context-clipboard-cta");
    await expect(cta).toContainText("Copied link ready");
    await expect(cta).not.toContainText("Clipboard file ready");
  });

  test("create with context can retry clipboard detection from an explicit button", async ({
    page,
  }) => {
    await stubClipboard(page, {
      kind: "deferred-text",
      firstText: "",
      nextText: "https://example.com/retry-link",
    });
    await loadApp(page);

    await page.getByTestId("create-agent-button").click();
    await page.getByTestId("create-agent-with-context").click();

    await expect(
      page.getByTestId("create-agent-context-clipboard-check")
    ).toBeVisible();
    await page
      .getByTestId("create-agent-context-clipboard-check-action")
      .click();

    const cta = page.getByTestId("create-agent-context-clipboard-cta");
    await expect(cta).toContainText("Copied link ready");
  });

  test("create with context explains blocked clipboard access", async ({
    page,
  }) => {
    await stubClipboard(page, { kind: "blocked" });
    await loadApp(page);

    await page.getByTestId("create-agent-button").click();
    await page.getByTestId("create-agent-with-context").click();

    const status = page.getByTestId("create-agent-context-clipboard-status");
    await expect(status).toContainText("Clipboard blocked by the browser.");

    await page
      .getByTestId("create-agent-context-clipboard-check-action")
      .click();
    await expect(status).toContainText("Clipboard blocked by the browser.");
  });

  test("create with context explains unsupported clipboard access", async ({
    page,
  }) => {
    await stubClipboard(page, { kind: "unsupported" });
    await loadApp(page);

    await page.getByTestId("create-agent-button").click();
    await page.getByTestId("create-agent-with-context").click();

    const status = page.getByTestId("create-agent-context-clipboard-status");
    await expect(status).toContainText("Clipboard read is unavailable here.");
    await expect(status).toContainText(
      "Use files, links, or instructions instead."
    );
  });

  test("create with context lets the user dismiss a clipboard suggestion", async ({
    page,
  }) => {
    await stubClipboard(page, {
      kind: "text",
      text: "https://example.com/dismiss-me",
    });
    await loadApp(page);

    await page.getByTestId("create-agent-button").click();
    await page.getByTestId("create-agent-with-context").click();

    const cta = page.getByTestId("create-agent-context-clipboard-cta");
    await expect(cta).toBeVisible();

    await page.getByTestId("create-agent-context-clipboard-dismiss").click();

    await expect(cta).not.toBeVisible();
  });

  test("create with context suggests a clipboard image without auto-attaching it", async ({
    page,
  }) => {
    await stubClipboard(page, {
      kind: "image",
      mimeType: "image/png",
      bytes: [137, 80, 78, 71, 13, 10, 26, 10],
    });
    await loadApp(page);

    await page.getByTestId("create-agent-button").click();
    await page.getByTestId("create-agent-with-context").click();

    const cta = page.getByTestId("create-agent-context-clipboard-cta");
    await expect(cta).toContainText("Clipboard image ready");
    await expect(
      page.getByText("No files added yet.", { exact: true })
    ).toBeVisible();

    await page.getByTestId("create-agent-context-clipboard-action").click();

    await expect(page.getByText("clipboard-image.png")).toBeVisible();
    await expect(cta).not.toBeVisible();
  });

  test("create with context validates manual links before adding them", async ({
    page,
  }) => {
    await loadApp(page);

    await page.getByTestId("create-agent-button").click();
    await page.getByTestId("create-agent-with-context").click();

    const prompt = page.getByTestId("create-agent-initial-prompt");
    await expect(prompt).toHaveAccessibleName("Instructions");

    const linkInput = page.getByTestId("create-agent-context-link-input");
    await expect(linkInput).toHaveAccessibleName("Link URL");

    await linkInput.fill("not-a-url");
    await expect(
      page.getByTestId("create-agent-context-link-error")
    ).toBeVisible();
    await expect(linkInput).toHaveAttribute(
      "aria-describedby",
      "create-agent-context-link-error"
    );
    await expect(
      page.getByTestId("create-agent-context-link-add")
    ).toBeDisabled();
    await expect(
      page.getByTestId("create-agent-context-submit")
    ).toBeDisabled();
  });
});
