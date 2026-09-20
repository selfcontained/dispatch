import { expect, test } from "@playwright/test";

import {
  authHeaders,
  callMcpToolViaAPI,
  cleanupE2EAgents,
  createAgentViaAPI,
} from "./helpers";

/** The stored state of one block, read back through the feed. */
async function blockState(
  request: Parameters<typeof callMcpToolViaAPI>[0],
  streamId: string,
  blockId: string
): Promise<Record<string, unknown> | null> {
  const res = await request.get(`/api/v1/streams/${streamId}/blocks`, {
    headers: authHeaders(),
  });
  const body = (await res.json()) as {
    entries: Array<{
      type: string;
      block?: { id: string; state: Record<string, unknown> | null };
    }>;
  };
  const entry = body.entries.find(
    (candidate) => candidate.type === "block" && candidate.block?.id === blockId
  );
  return entry?.block?.state ?? null;
}

test.describe("Stream blocks", () => {
  test.afterEach(async ({ request }) => {
    await cleanupE2EAgents(request);
  });

  test("a review block lists its findings, resolves through the state route and opens a finding's thread", async ({
    page,
    request,
  }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-review-block-${Date.now()}`,
    });
    // A reviewer would post this with `to` set to the agent it reviewed;
    // the agent's own post lands in the same stream and renders the same.
    const posted = (await callMcpToolViaAPI(request, agent.id, "post", {
      text: "",
      review: {
        verdict: "request_changes",
        summary: "Two things to fix before this ships. The rest reads well.",
        findings: [
          {
            id: "f1",
            severity: "major",
            title: "Retry spinner never settles",
            body: "After a timeout the spinner keeps going.",
            path: "apps/web/src/components/LoadingState.tsx",
            line: 56,
          },
          {
            id: "f2",
            severity: "nit",
            title: "Stray console.log",
            body: "Left over from debugging.",
            path: "apps/web/src/lib/api.ts",
            line: 12,
          },
        ],
      },
    })) as { result?: { content?: Array<{ text?: string }> } };
    const reviewId = (
      JSON.parse(posted.result?.content?.[0]?.text ?? "{}") as { id?: string }
    ).id;
    expect(reviewId).toBeTruthy();

    await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
    const pane = page.getByTestId("chat-pane");
    const review = pane.getByTestId("chat-review-block");
    await expect(review).toBeVisible();

    // A card of its own: the verdict and counts in the header, and, since
    // findings are open, the rows already showing.
    await expect(review.getByTestId("chat-review-verdict")).toHaveText(
      "Changes requested"
    );
    await expect(review.getByTestId("chat-review-counts")).toHaveText(
      "2 findings · 2 open"
    );
    await expect(review.getByTestId("chat-review-details")).toHaveAttribute(
      "data-open",
      "true"
    );
    await expect(review.getByTestId("chat-review-details")).toContainText(
      "Two things to fix before this ships."
    );
    const findings = review.getByTestId("chat-review-finding");
    await expect(findings).toHaveCount(2);
    await expect(findings.nth(0)).toHaveAttribute("data-finding-id", "f1");
    await expect(findings.nth(0)).toContainText("Retry spinner never settles");
    await expect(findings.nth(0)).toContainText("LoadingState.tsx:56");
    await expect(
      findings.nth(0).getByTestId("chat-review-severity")
    ).toHaveText("major");
    // The row is compact: no body, no controls.
    await expect(findings.nth(0)).not.toContainText(
      "Left over from debugging."
    );
    await expect(review.getByTestId("chat-review-resolve")).toHaveCount(0);

    // A row opens the finding's own panel, where Resolve lives; the change
    // goes through PATCH …/state and the row follows.
    await findings.nth(0).getByTestId("chat-review-finding-link").click();
    await page.waitForURL(
      new RegExp(`/agents/${agent.id}\\?thread=${reviewId}&finding=f1$`)
    );
    const thread = page.getByTestId("chat-thread-panel");
    await expect(thread).toBeVisible();
    await expect(thread).toHaveAttribute("data-block-id", reviewId!);
    const detail = thread.getByTestId("chat-finding-detail");
    await expect(detail).toContainText("Retry spinner never settles");
    await detail.getByTestId("chat-review-resolve").click();
    await expect(detail.getByTestId("chat-review-finding-status")).toHaveText(
      "Fixed"
    );
    await expect(findings.nth(0)).toHaveAttribute("data-status", "resolved");
    await expect(review.getByTestId("chat-review-counts")).toHaveText(
      "2 findings · 1 open"
    );
    await expect
      .poll(() => blockState(request, agent.id, reviewId!))
      .toMatchObject({
        findings: { f1: { status: "resolved", resolution: "fixed" } },
      });

    // Dismissing wants a reason and records it; Reopen takes it back.
    await findings.nth(1).getByTestId("chat-review-finding-link").click();
    await page.waitForURL(
      new RegExp(`/agents/${agent.id}\\?thread=${reviewId}&finding=f2$`)
    );
    await expect(detail).toContainText("Left over from debugging.");
    await detail.getByTestId("chat-review-dismiss").click();
    await page
      .getByTestId("chat-review-dismiss-note")
      .fill("Debug logging stays until the beta.");
    await page.getByTestId("chat-review-dismiss-confirm").click();
    await expect(findings.nth(1)).toHaveAttribute("data-outcome", "dismissed");
    await expect(detail.getByTestId("chat-review-finding-note")).toHaveText(
      "Debug logging stays until the beta."
    );
    await expect
      .poll(() => blockState(request, agent.id, reviewId!))
      .toMatchObject({
        findings: {
          f2: {
            status: "resolved",
            resolution: "dismissed",
            note: "Debug logging stays until the beta.",
          },
        },
      });
    await detail.getByTestId("chat-review-reopen").click();
    await page.getByTestId("chat-review-reopen-confirm").click();
    await expect(findings.nth(1)).toHaveAttribute("data-status", "open");
    await expect
      .poll(() => blockState(request, agent.id, reviewId!))
      .toMatchObject({ findings: { f2: { status: "open" } } });

    // A comment on the finding lands in its discussion, tagged to it.
    await thread
      .getByTestId("chat-composer-input")
      .fill("Fixing this one now.");
    await thread.getByTestId("chat-composer-send").click();
    await expect(thread.getByTestId("chat-thread-replies")).toContainText(
      "Fixing this one now."
    );
    await expect(findings.nth(1)).toContainText("1 comment");

    await page.screenshot({
      path: test.info().outputPath("review-block-thread.png"),
      fullPage: true,
    });
  });

  test("the rail shows an open question, answers it in place, and a tasks block is read-only", async ({
    page,
    request,
  }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-rail-${Date.now()}`,
    });
    await callMcpToolViaAPI(request, agent.id, "post", {
      text: "Which database should the migration target?",
      question: {
        options: [{ label: "Postgres" }, { label: "SQLite", value: "sqlite" }],
      },
    });
    await callMcpToolViaAPI(request, agent.id, "post", {
      text: "Plan",
      tasks: {
        items: [
          { id: "a", text: "Write the migration" },
          { id: "b", text: "Wire the route" },
        ],
      },
    });
    await callMcpToolViaAPI(request, agent.id, "post", {
      link: { url: "https://example.com/preview", title: "Preview" },
    });

    await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("chat-pane")).toBeVisible();

    // The closed sidebar's toggle counts the open question.
    const toggle = page.getByTestId("toggle-media-sidebar");
    await expect(toggle.getByTestId("toggle-media-sidebar-badge")).toHaveText(
      "1"
    );
    await toggle.click();
    const sidebar = page.getByTestId("media-sidebar");
    await sidebar.getByTestId("sidebar-tab-rail").click();
    const rail = sidebar.getByTestId("stream-rail");
    await expect(rail).toHaveAttribute("data-open-inputs", "1");
    const input = rail.getByTestId("rail-input");
    await expect(input).toHaveCount(1);
    await expect(input).toContainText(
      "Which database should the migration target?"
    );
    await expect(
      sidebar.getByTestId("stream-rail-link").getByRole("link")
    ).toHaveAttribute("href", "https://example.com/preview");

    // The tasks block in the feed is a read-only checklist.
    const tasks = page.getByTestId("chat-tasks-block");
    await expect(tasks.getByTestId("chat-tasks-header")).toContainText(
      "0/2 done"
    );
    await expect(tasks.getByTestId("chat-task")).toHaveCount(2);
    await expect(tasks.getByRole("checkbox")).toHaveCount(0);

    await page.screenshot({
      path: test.info().outputPath("rail-open-question.png"),
      fullPage: true,
    });

    // Answering from the rail records the answer and clears the rail.
    await input.getByTestId("chat-question-option").nth(1).click();
    await expect(rail).toHaveAttribute("data-open-inputs", "0");
    await expect(rail.getByTestId("rail-input")).toHaveCount(0);
    await expect(toggle.getByTestId("toggle-media-sidebar-badge")).toHaveCount(
      0
    );
    const answered = page
      .getByTestId("chat-pane")
      .getByTestId("chat-question-options");
    await expect(answered).toContainText("Answered");
    await expect(answered).toContainText("SQLite");
  });

  test("the Changes tab posts a hand-written review as a review block", async ({
    page,
    request,
  }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-hand-review-${Date.now()}`,
    });
    await page.goto(`/agents/${agent.id}/changes`, {
      waitUntil: "domcontentloaded",
    });
    const toolbar = page.getByTestId("changes-toolbar");
    await expect(toolbar).toBeVisible();
    await expect(toolbar.getByTestId("launch-reviewer-button")).toBeVisible();

    await toolbar.getByTestId("changes-start-review").click();
    const bar = page.getByTestId("review-mode-bar");
    await expect(bar.getByTestId("review-mode-count")).toHaveText("0 comments");
    await bar.getByTestId("review-mode-submit").click();

    const dialog = page.getByTestId("submit-review-dialog");
    await expect(dialog).toBeVisible();
    const post = dialog.getByTestId("review-post");
    await expect(post).toBeDisabled();
    await dialog.getByTestId("review-summary").fill("Looks good to me.");
    await dialog.getByTestId("review-verdict").click();
    await page.getByRole("option", { name: "Approve" }).click();
    await post.click();

    // The review lands in the stream and its thread opens.
    await page.waitForURL(new RegExp(`/agents/${agent.id}\\?thread=`));
    const thread = page.getByTestId("chat-thread-panel");
    await expect(thread.getByTestId("chat-review-verdict")).toHaveText(
      "Approved"
    );
    await expect(thread.getByTestId("chat-review-counts")).toHaveText(
      "No findings"
    );
    // The feed shows it too, beside the thread panel.
    await expect(
      page
        .getByTestId("chat-pane")
        .locator("[data-chat-entry-id] [data-testid='chat-review-block']")
    ).toBeVisible();
  });
});
