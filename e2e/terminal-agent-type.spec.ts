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
    | { kind: "pending-text"; text: string }
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
          : value.kind === "pending-text"
            ? {
                read: async () => [],
                readText: async () =>
                  await new Promise<string>((resolve) => {
                    window.__dispatchResolveClipboardRead = () =>
                      resolve(value.text);
                  }),
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
    __dispatchResolveClipboardRead?: () => void;
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

    // The link input lives in the Add Context popover behind "Add link".
    await page.getByTestId("create-agent-context-files-button").click();
    await page.getByRole("button", { name: "Add link" }).click();
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
    await expect(cta).toContainText("Add copied link?");
    await expect(
      page.getByText("No links added yet.", { exact: true })
    ).toBeVisible();

    await page.getByTestId("create-agent-context-clipboard-action").click();

    await expect(
      page.locator('[title="https://example.com/docs/launch-context"]')
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
    await expect(cta).toContainText("Add copied link?");
    await expect(cta).not.toContainText("Clipboard file ready");
  });

  test("create with context advances before clipboard lookup resolves", async ({
    page,
  }) => {
    await stubClipboard(page, {
      kind: "pending-text",
      text: "https://example.com/mounted-step-read",
    });
    await loadApp(page);

    await page.getByTestId("create-agent-button").click();
    await page.getByTestId("create-agent-with-context").click();

    await expect(page.getByTestId("create-agent-context-form")).toBeVisible();
    await expect(page.getByText("Create with context")).toBeVisible();

    await page.evaluate(() => window.__dispatchResolveClipboardRead?.());

    await expect(
      page.getByTestId("create-agent-context-clipboard-cta")
    ).toContainText("Add copied link?");
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
    await expect(cta).toContainText("Add copied link?");
  });

  test("create with context shows feedback when clipboard access is blocked", async ({
    page,
  }) => {
    await stubClipboard(page, { kind: "blocked" });
    await loadApp(page);

    await page.getByTestId("create-agent-button").click();
    await page.getByTestId("create-agent-with-context").click();

    const readButton = page.getByTestId(
      "create-agent-context-clipboard-check-action"
    );
    await expect(readButton).toBeVisible();

    await readButton.click();
    await expect(readButton).toBeVisible();
    await expect(
      page.getByTestId("create-agent-context-clipboard-cta")
    ).not.toBeVisible();
    await expect(
      page.getByTestId("create-agent-context-clipboard-feedback")
    ).toContainText("Clipboard access was blocked.");
  });

  test("create with context hides the read button when clipboard APIs are unavailable", async ({
    page,
  }) => {
    await stubClipboard(page, { kind: "unsupported" });
    await loadApp(page);

    await page.getByTestId("create-agent-button").click();
    await page.getByTestId("create-agent-with-context").click();

    await expect(
      page.getByTestId("create-agent-context-clipboard-check")
    ).not.toBeVisible();
  });

  test("create with context intercepts pasted links in the prompt textarea", async ({
    page,
  }) => {
    await loadApp(page);

    await page.getByTestId("create-agent-button").click();
    await page.getByTestId("create-agent-with-context").click();

    const prompt = page.getByTestId("create-agent-initial-prompt");
    const defaultAllowed = await prompt.evaluate((node) => {
      const data = new DataTransfer();
      data.setData("text/plain", "https://example.com/pasted-link");
      return node.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: data,
        })
      );
    });

    expect(defaultAllowed).toBe(false);
    await expect(
      page.getByTestId("create-agent-context-clipboard-cta")
    ).toContainText("Add copied link?");
    await expect(prompt).toHaveValue("");
  });

  test("create with context lets plain text paste pass through in the prompt textarea", async ({
    page,
  }) => {
    await loadApp(page);

    await page.getByTestId("create-agent-button").click();
    await page.getByTestId("create-agent-with-context").click();

    const prompt = page.getByTestId("create-agent-initial-prompt");
    const defaultAllowed = await prompt.evaluate((node) => {
      const data = new DataTransfer();
      data.setData("text/plain", "ordinary prompt text");
      return node.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: data,
        })
      );
    });

    expect(defaultAllowed).toBe(true);
    await expect(
      page.getByTestId("create-agent-context-clipboard-cta")
    ).not.toBeVisible();
  });

  test("create with context does not intercept paste in the link input", async ({
    page,
  }) => {
    await loadApp(page);

    await page.getByTestId("create-agent-button").click();
    await page.getByTestId("create-agent-with-context").click();
    await page.getByTestId("create-agent-context-files-button").click();
    await page.getByRole("button", { name: "Add link" }).click();

    const linkInput = page.getByTestId("create-agent-context-link-input");
    const defaultAllowed = await linkInput.evaluate((node) => {
      const data = new DataTransfer();
      data.setData("text/plain", "https://example.com/keep-in-field");
      return node.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: data,
        })
      );
    });

    expect(defaultAllowed).toBe(true);
    await expect(
      page.getByTestId("create-agent-context-clipboard-cta")
    ).not.toBeVisible();
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
    await expect(cta).toContainText("Add copied image?");
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

    await page.getByTestId("create-agent-context-files-button").click();
    await page.getByRole("button", { name: "Add link" }).click();

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

  test("create with context keeps invalid manual-link drafts open on Enter", async ({
    page,
  }) => {
    await loadApp(page);

    await page.getByTestId("create-agent-button").click();
    await page.getByTestId("create-agent-with-context").click();

    await page.getByTestId("create-agent-context-files-button").click();
    await page.getByRole("button", { name: "Add link" }).click();

    const linkInput = page.getByTestId("create-agent-context-link-input");
    await linkInput.fill("not-a-url");
    await linkInput.press("Enter");

    await expect(linkInput).toBeVisible();
    await expect(linkInput).toHaveValue("not-a-url");
    await expect(
      page.getByTestId("create-agent-context-link-error")
    ).toBeVisible();
  });

  test("backing out of create with context clears queued context", async ({
    page,
  }) => {
    await loadApp(page);

    await page.getByTestId("create-agent-button").click();
    await page.getByTestId("create-agent-with-context").click();

    await page.getByTestId("create-agent-initial-prompt").fill("Use this.");
    await page.getByTestId("create-agent-context-files-button").click();
    await page.getByRole("button", { name: "Add link" }).click();
    await page
      .getByTestId("create-agent-context-link-input")
      .fill("https://example.com/preserved");
    await page.getByTestId("create-agent-context-link-add").click();

    await page.getByTestId("create-agent-context-back").click();
    await page.getByTestId("create-agent-with-context").click();
    await expect(page.getByTestId("create-agent-initial-prompt")).toHaveValue(
      ""
    );
    await expect(
      page.getByText("No links added yet.", { exact: true })
    ).toBeVisible();
    await page.getByTestId("create-agent-context-back").click();

    const createRequest = page.waitForRequest(
      (request) =>
        request.method() === "POST" && request.url().includes("/api/v1/agents")
    );

    await page.getByTestId("create-agent-submit").click();

    const request = await createRequest;
    expect(request.postData()).not.toContain("startupLinks");
    expect(request.postData()).not.toContain("https://example.com/preserved");
    expect(request.postData()).not.toContain("Use this.");
  });

  test("create with context clears an unconfirmed link draft when the popover closes", async ({
    page,
  }) => {
    await loadApp(page);

    await page.getByTestId("create-agent-button").click();
    await page.getByTestId("create-agent-with-context").click();

    await page.getByTestId("create-agent-context-files-button").click();
    await page.getByRole("button", { name: "Add link" }).click();

    const linkInput = page.getByTestId("create-agent-context-link-input");
    await linkInput.fill("https://example.com/unconfirmed");
    await page.keyboard.press("Escape");

    await page.getByTestId("create-agent-context-files-button").click();
    await page.getByRole("button", { name: "Add link" }).click();
    await expect(linkInput).toHaveValue("");
  });
});
