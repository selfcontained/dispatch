import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test, type APIRequestContext } from "@playwright/test";

import {
  authHeaders,
  callMcpToolViaAPI,
  cleanupE2EAgents,
  createAgentViaAPI,
} from "./helpers";

/**
 * The review loop as people see it: a reviewer's findings sit in the diff
 * at their lines and in the drawer, get fixed / dismissed / reopened from
 * either place, and every comment reaches one side of the review. The
 * agents are driven through their MCP tools, so this runs on the inert
 * runtime; what it proves is the stream, the drawer and the diff.
 */

const FILE = "src/slug.ts";
const LINES = Array.from(
  { length: 14 },
  (_, i) => `export const line${i + 1} = ${i + 1};`
);

/** A git repo with one committed file and uncommitted edits on lines 4 and 10. */
function repoWithChanges(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dispatch-e2e-review-"));
  const run = (cmd: string) => execSync(cmd, { cwd: dir, stdio: "ignore" });
  run("git init -q -b main");
  run('git config user.email "e2e@test" && git config user.name "e2e"');
  execSync(`mkdir -p ${path.join(dir, "src")}`);
  writeFileSync(path.join(dir, FILE), LINES.join("\n") + "\n");
  run("git add -A && git commit -q -m init");
  const edited = [...LINES];
  edited[3] = "export const line4 = 40; // changed";
  edited[9] = "export const line10 = 100; // changed";
  writeFileSync(path.join(dir, FILE), edited.join("\n") + "\n");
  return dir;
}

async function reviewState(
  request: APIRequestContext,
  streamId: string,
  reviewId: string
): Promise<
  Record<string, { status: string; resolution?: string; note?: string }>
> {
  const res = await request.get(`/api/v1/streams/${streamId}/blocks`, {
    headers: authHeaders(),
  });
  const body = (await res.json()) as {
    entries: Array<{
      type: string;
      block?: { id: string; state: { findings: Record<string, never> } };
    }>;
  };
  const entry = body.entries.find(
    (e) => e.type === "block" && e.block?.id === reviewId
  );
  return (entry?.block?.state?.findings ?? {}) as never;
}

async function thread(
  request: APIRequestContext,
  streamId: string,
  rootId: string
) {
  const res = await request.get(
    `/api/v1/streams/${streamId}/blocks/${rootId}/thread`,
    {
      headers: authHeaders(),
    }
  );
  return (await res.json()) as {
    replies: Array<{
      id: string;
      text: string;
      toAgentId: string | null;
      readAt: string | null;
      data: { findingId?: string } | null;
    }>;
  };
}

/** On the live runtime an agent's host takes a moment; its tools wait for it. */
async function launched(
  request: APIRequestContext,
  agentId: string
): Promise<void> {
  await expect
    .poll(
      async () => {
        const res = await request.get(`/api/v1/agents/${agentId}`, {
          headers: authHeaders(),
        });
        return ((await res.json()) as { agent: { status: string } }).agent
          .status;
      },
      { timeout: 30_000 }
    )
    .not.toBe("creating");
}

function postedId(result: Record<string, unknown>): string {
  const text = (result as { result?: { content?: Array<{ text?: string }> } })
    .result?.content?.[0]?.text;
  return (JSON.parse(text ?? "{}") as { id?: string }).id ?? "";
}

test.describe("Review loop", () => {
  test.afterEach(async ({ request }) => {
    await cleanupE2EAgents(request, "all");
  });

  test("findings sit in the diff and the drawer; fixes, dismissals, reopens and comments route to one side", async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const repo = repoWithChanges();
    const builder = await createAgentViaAPI(request, {
      name: `e2e-loop-builder-${Date.now()}`,
      type: "claude",
      cwd: repo,
    });
    await launched(request, builder.id);
    const reviewer = await createAgentViaAPI(request, {
      name: `e2e-loop-reviewer-${Date.now()}`,
      type: "codex",
      cwd: repo,
      parentAgentId: builder.id,
    });
    await launched(request, reviewer.id);

    // The reviewer posts its review to the builder: two findings on the
    // changed lines.
    const posted = await callMcpToolViaAPI(request, reviewer.id, "post", {
      to: builder.id,
      text: "Checked both edits.",
      review: {
        verdict: "request_changes",
        summary: "Two things on the edited lines.",
        findings: [
          {
            id: "f-four",
            severity: "major",
            title: "Line four is now forty",
            body: "Was that intended?",
            path: FILE,
            line: 4,
          },
          {
            id: "f-ten",
            severity: "nit",
            title: "Line ten comment",
            body: "Drop the trailing comment.",
            path: FILE,
            line: 10,
          },
        ],
      },
    });
    const reviewId = postedId(posted);
    expect(reviewId).toBeTruthy();

    // Changes tab: one card per finding, at its line, folded.
    await page.goto(`/agents/${builder.id}/changes`, {
      waitUntil: "domcontentloaded",
    });
    const cards = page.getByTestId("diff-finding");
    await expect(cards).toHaveCount(2);
    await expect(cards.nth(0)).toHaveAttribute(
      "data-finding-key",
      `${reviewId}:f-four`
    );
    await expect(cards.nth(0)).toHaveAttribute("data-expanded", "false");
    await expect(cards.nth(0)).toContainText("Line four is now forty");
    await expect(cards.nth(0)).toContainText(reviewer.name);

    // Mark the first fixed from the diff.
    await cards.nth(0).getByTestId("diff-finding-header").click();
    await expect(cards.nth(0)).toHaveAttribute("data-expanded", "true");
    await expect(cards.nth(0)).toContainText("Was that intended?");
    await cards.nth(0).getByTestId("chat-review-resolve").click();
    await expect(cards.nth(0)).toHaveAttribute("data-outcome", "fixed");
    await expect
      .poll(() => reviewState(request, builder.id, reviewId))
      .toMatchObject({ "f-four": { status: "resolved", resolution: "fixed" } });

    // Dismiss the second with a note from the diff.
    await cards.nth(1).getByTestId("diff-finding-header").click();
    await cards.nth(1).getByTestId("chat-review-dismiss").click();
    await page
      .getByTestId("chat-review-dismiss-note")
      .fill("Comment stays for now.");
    await page.getByTestId("chat-review-dismiss-confirm").click();
    await expect(cards.nth(1)).toHaveAttribute("data-outcome", "dismissed");
    await expect(cards.nth(1).getByTestId("diff-finding-note")).toContainText(
      "Comment stays for now."
    );
    await expect
      .poll(() => reviewState(request, builder.id, reviewId))
      .toMatchObject({
        "f-ten": {
          status: "resolved",
          resolution: "dismissed",
          note: "Comment stays for now.",
        },
      });

    // Discussion opens the finding's page in the drawer, over the review page,
    // without leaving the Changes tab.
    await cards.nth(1).getByTestId("diff-finding-open").click();
    await page.waitForURL(
      new RegExp(
        `/agents/${builder.id}/changes\\?thread=${reviewId}&finding=f-ten$`
      )
    );
    const drawer = page.getByTestId("drawer");
    await expect(drawer).toHaveAttribute("data-depth", "2");
    await expect(page.getByTestId("drawer-title")).toHaveText("Finding");
    const top = page.locator('[data-testid="drawer-page"][data-top="true"]');
    await expect(top.getByTestId("chat-review-finding-status")).toHaveText(
      "Dismissed"
    );
    await expect(top.getByTestId("chat-review-finding-note")).toContainText(
      "Comment stays for now."
    );

    // A person's comment on a resolved finding goes to the reviewer.
    await top
      .getByTestId("chat-composer-input")
      .fill("Reviewer, fine with this?");
    await top.getByTestId("chat-composer-send").click();
    await expect(top.getByTestId("chat-thread-replies")).toContainText(
      "Reviewer, fine with this?"
    );
    await expect
      .poll(async () =>
        (await thread(request, builder.id, reviewId)).replies.map((r) => [
          r.text,
          r.toAgentId,
          r.data?.findingId,
        ])
      )
      .toContainEqual(["Reviewer, fine with this?", reviewer.id, "f-ten"]);

    // Reopen it with a note from the drawer: the builder's move again.
    await top.getByTestId("chat-review-reopen").click();
    await page
      .getByTestId("chat-review-reopen-note")
      .fill("Actually, drop it.");
    await page.getByTestId("chat-review-reopen-confirm").click();
    await expect(top.getByTestId("chat-review-finding-status")).toHaveText(
      "Open"
    );
    await expect(top.getByTestId("chat-review-finding-record")).toContainText(
      "Reopened by you"
    );
    await expect
      .poll(() => reviewState(request, builder.id, reviewId))
      .toMatchObject({
        "f-ten": { status: "open", note: "Actually, drop it." },
      });
    await expect(cards.nth(1)).toHaveAttribute("data-outcome", "open");

    // Back on the review page. The builder's comment goes to the reviewer;
    // the reviewer's answer to it comes back to the builder, inherits the
    // finding, and is unseen until the finding's page is opened again.
    await page.getByTestId("drawer-back").click();
    await expect(drawer).toHaveAttribute("data-depth", "1");
    await expect(page.getByTestId("drawer-title")).toHaveText("Review");
    const builderSaid = await callMcpToolViaAPI(request, builder.id, "post", {
      replyTo: reviewId,
      finding: "f-ten",
      text: "Dropped it in the next commit.",
    });
    const builderCommentId = postedId(builderSaid);
    await callMcpToolViaAPI(request, reviewer.id, "post", {
      replyTo: builderCommentId,
      text: "Confirmed, thanks.",
    });
    const replies = (await thread(request, builder.id, reviewId)).replies;
    expect(
      replies.map((r) => [r.text, r.toAgentId, r.data?.findingId])
    ).toEqual(
      expect.arrayContaining([
        ["Dropped it in the next commit.", reviewer.id, "f-ten"],
        ["Confirmed, thanks.", builder.id, "f-ten"],
      ])
    );
    // Seen from the review page as they land (it lists every comment), so
    // the unread marks show where the review is only a card: the rail.
    await page.getByTestId("drawer-back").click();
    await expect(drawer).toHaveAttribute("data-depth", "0");
    // The review page slides out before it unmounts; until then it still
    // counts as reading, so wait for the home page to be alone.
    await expect(page.getByTestId("drawer-page")).toHaveCount(1);
    await drawer.getByTestId("sidebar-tab-rail").click();
    const railCard = drawer.getByTestId("rail-review");
    await expect(railCard).toHaveCount(1);
    await callMcpToolViaAPI(request, reviewer.id, "post", {
      replyTo: reviewId,
      finding: "f-four",
      text: "One more thought on four.",
    });
    await expect(railCard.getByTestId("rail-review-unread")).toBeVisible();
    await expect(railCard.getByTestId("rail-review-unread")).toHaveText("1");
    // Opening the review reads them.
    await railCard.click();
    await expect(drawer).toHaveAttribute("data-depth", "1");
    await expect
      .poll(async () =>
        (await thread(request, builder.id, reviewId)).replies
          .filter((r) => r.text === "One more thought on four.")
          .map((r) => r.readAt !== null)
      )
      .toEqual([true]);

    // Back home: the rail lists the review with where it stands.
    await page.getByTestId("drawer-back").click();
    await expect(drawer).toHaveAttribute("data-depth", "0");
    await page.waitForURL(new RegExp(`/agents/${builder.id}/changes$`));
    await drawer.getByTestId("sidebar-tab-rail").click();
    await expect(railCard.getByTestId("rail-review-status")).toHaveText(
      "In progress"
    );
    await expect(railCard).toContainText("2 findings · 1 open");
  });

  test("questions between agents: labels stay short, the addressee answers by replying, an author closes its own", async ({
    request,
  }) => {
    const builder = await createAgentViaAPI(request, {
      name: `e2e-q-builder-${Date.now()}`,
      type: "claude",
    });
    await launched(request, builder.id);
    const reviewer = await createAgentViaAPI(request, {
      name: `e2e-q-reviewer-${Date.now()}`,
      type: "codex",
      parentAgentId: builder.id,
    });
    await launched(request, reviewer.id);

    await expect(
      callMcpToolViaAPI(request, reviewer.id, "post", {
        to: builder.id,
        text: "Which?",
        question: { options: [{ label: "x".repeat(33) }] },
      })
    ).rejects.toThrow(/32 characters/);

    const asked = await callMcpToolViaAPI(request, reviewer.id, "post", {
      to: builder.id,
      text: "Keep the hard cut, or return empty?",
      question: { options: [{ label: "Keep it" }, { label: "Return empty" }] },
    });
    const questionId = postedId(asked);
    await callMcpToolViaAPI(request, builder.id, "post", {
      replyTo: questionId,
      text: "Keep it",
    });
    await expect
      .poll(async () => {
        const res = await request.get(
          `/api/v1/streams/${builder.id}/blocks/${questionId}/thread`,
          {
            headers: authHeaders(),
          }
        );
        const body = (await res.json()) as {
          root: {
            state: { answer?: { value: string; by: { agentId?: string } } };
          };
        };
        return body.root.state.answer;
      })
      .toMatchObject({
        value: "Keep it",
        label: "Keep it",
        by: { kind: "agent", agentId: builder.id },
      });

    // The builder asks the user, then sorts it out itself.
    const own = await callMcpToolViaAPI(request, builder.id, "post", {
      text: "Discard the stray edit?",
      question: { options: [{ label: "Discard it" }, { label: "Keep it" }] },
    });
    const ownId = postedId(own);
    await callMcpToolViaAPI(request, builder.id, "update", {
      id: ownId,
      state: { answer: "Resolved on my own" },
    });
    const unread = await request.get(`/api/v1/chat/unread`, {
      headers: authHeaders(),
    });
    const summary = (await unread.json()) as {
      agents: Record<string, { pendingQuestions: number }>;
    };
    expect(summary.agents[builder.id]?.pendingQuestions ?? 0).toBe(0);
  });

  test("on a phone the drawer's pages ride in the sheet", async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const builder = await createAgentViaAPI(request, {
      name: `e2e-loop-mobile-${Date.now()}`,
      type: "claude",
    });
    await launched(request, builder.id);
    const posted = await callMcpToolViaAPI(request, builder.id, "post", {
      text: "",
      review: {
        verdict: "comment",
        summary: "One note.",
        findings: [
          { id: "f1", severity: "nit", title: "A nit", body: "Tiny." },
        ],
      },
    });
    const reviewId = postedId(posted);
    await page.goto(`/agents/${builder.id}?thread=${reviewId}&finding=f1`, {
      waitUntil: "domcontentloaded",
    });
    const sheet = page.getByRole("dialog", { name: "Drawer" });
    await expect(sheet.getByTestId("drawer")).toHaveAttribute(
      "data-depth",
      "2"
    );
    await expect(sheet.getByTestId("drawer-title")).toHaveText("Finding");
    await sheet.getByTestId("drawer-back").click();
    await expect(sheet.getByTestId("drawer-title")).toHaveText("Review");
    await sheet.getByTestId("drawer-back").click();
    await expect(sheet.getByTestId("drawer")).toHaveAttribute(
      "data-depth",
      "0"
    );
  });
});
