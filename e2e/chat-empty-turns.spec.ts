import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { expect, test } from "@playwright/test";
import { authHeaders, cleanupE2EAgents, createAgentViaAPI } from "./helpers";

test.use({ deviceScaleFactor: 2 });

// Persist the same turn anchors and event rows as internal notification
// wakeups. Exercise the real assembler, compact feed, and UI without
// starting a provider or mocking the feed response.
for (const width of [1280, 390]) {
  test(`empty notification turns disappear while activity and replies remain at ${width}px`, async ({
    page,
    request,
  }) => {
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 1,
    });
    const agent = await createAgentViaAPI(request, {
      name: `Notification feed ${width}`,
    });
    const headers = authHeaders();
    // Launch reconciles orphaned open turns. Seed only after that lifecycle
    // boundary, so the active fixture is a current turn rather than a crash.
    await expect
      .poll(async () => {
        const response = await request.get(`/api/v1/agents/${agent.id}`, {
          headers,
        });
        return (await response.json()).agent.status;
      })
      .toBe("running");
    let seq = 0;
    const base = Date.now() - 120_000;
    const event = async (
      kind: string,
      payload: object,
      at: Date
    ): Promise<number> => {
      const result = await pool.query(
        `INSERT INTO agent_stream_events
           (agent_id, seq, kind, payload, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $5) RETURNING id`,
        [agent.id, ++seq, kind, JSON.stringify(payload), at]
      );
      return Number(result.rows[0].id);
    };
    const turn = async (
      index: number,
      options: {
        text?: string;
        tool?: boolean;
        error?: string;
        active?: boolean;
      } = {}
    ) => {
      const at = new Date(base + index * 10_000);
      const endedAt = new Date(at.getTime() + 5000).toISOString();
      const payload = {
        state: options.active ? "started" : "settled",
        prompt: { source: "system", text: "Task watch notification" },
        model: "notification-model",
        ...(options.active ? {} : { endedAt, stopReason: "end_turn" }),
        ...(options.error ? { error: options.error, retry: "open" } : {}),
      };
      const eventId = await event("turn", payload, at);
      if (options.tool) {
        await event(
          "tool_call",
          {
            toolKind: "edit",
            title: "edit notification-proof.ts",
            status: "completed",
            diff: {
              path: "notification-proof.ts",
              oldText: "before",
              newText: "after",
            },
          },
          new Date(at.getTime() + 1000)
        );
      }
      if (options.text) {
        await event(
          "assistant",
          { text: options.text, streaming: false },
          new Date(at.getTime() + 2000)
        );
      }
      const id = randomUUID();
      await pool.query(
        `INSERT INTO blocks
           (id, stream_id, author_kind, author_agent_id, kind, origin, data, text, created_at, updated_at)
         VALUES ($1, $2, 'agent', $2, 'text', 'turn', $3, $4, $5, $5)`,
        [
          id,
          agent.id,
          JSON.stringify({ turnEventId: eventId }),
          options.text ?? "",
          at,
        ]
      );
      return { id, eventId, payload, at };
    };
    try {
      const empty = [];
      for (let i = 0; i < 4; i++) empty.push(await turn(i));
      const answer = await turn(4, {
        text: "Ordinary answer remains visible.",
      });
      const activity = await turn(5, { tool: true });
      const artifact = await turn(6);
      await pool.query(
        `INSERT INTO blocks
           (id, stream_id, author_kind, author_agent_id, kind, text, attachments, created_at)
         VALUES ($1, $2, 'agent', $2, 'text', 'Retained notification artifact', $3, $4)`,
        [
          randomUUID(),
          agent.id,
          JSON.stringify([
            { type: "code", code: "proof retained", language: "text" },
          ]),
          new Date(artifact.at.getTime() + 1000),
        ]
      );
      const reply = await turn(7);
      await pool.query(
        `INSERT INTO blocks
           (id, stream_id, author_kind, author_agent_id, kind, text, thread_id, reply_to, created_at)
         VALUES ($1, $2, 'agent', $2, 'text', 'Reply still accessible.', $3, $3, $4)`,
        [randomUUID(), agent.id, reply.id, new Date(reply.at.getTime() + 1000)]
      );
      const error = await turn(8, {
        error: "Notification engine failed visibly.",
      });
      const active = await turn(9, { active: true });
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
      const pane = page.getByTestId("chat-pane").filter({ visible: true });
      await expect(pane.getByTestId("chat-composer-input")).toBeEditable();
      const row = (id: string) => pane.locator(`[data-chat-entry-id="${id}"]`);
      for (const entry of empty) await expect(row(entry.id)).toHaveCount(0);
      await expect(row(answer.id)).toContainText(
        "Ordinary answer remains visible."
      );
      await expect(row(error.id)).toContainText(
        "Notification engine failed visibly."
      );
      await expect(row(artifact.id)).toContainText(
        "Retained notification artifact"
      );
      await expect(row(active.id)).toBeVisible();
      const summary = row(activity.id).getByTestId("harness-activity-summary");
      await summary.click();
      await expect(summary).toHaveAttribute("aria-expanded", "true");
      await expect(row(activity.id)).toContainText("notification-proof.ts");
      await summary.click();
      await expect(summary).toHaveAttribute("aria-expanded", "false");
      await row(reply.id).getByTestId("chat-reply-in-thread").click();
      await expect(
        page.getByTestId("chat-thread-panel").filter({ visible: true })
      ).toContainText("Reply still accessible.");
      await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });

      // An open turn is retained, but its empty successful settlement is
      // omitted after a persisted reload; no underlying row is removed.
      await pool.query(
        `UPDATE agent_stream_events SET payload = $2, updated_at = NOW() WHERE id = $1`,
        [
          active.eventId,
          JSON.stringify({
            ...active.payload,
            state: "settled",
            endedAt: new Date().toISOString(),
            stopReason: "end_turn",
          }),
        ]
      );
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(row(answer.id)).toBeVisible();
      await expect(row(active.id)).toHaveCount(0);
      const persisted = await request.get(
        `/api/v1/streams/${agent.id}/blocks`,
        { headers }
      );
      expect(persisted.ok()).toBeTruthy();
      const feed = await persisted.json();
      for (const entry of [...empty, active]) {
        expect(
          feed.entries.find((item: { id: string }) => item.id === entry.id)
            ?.block.turn.settled
        ).toBe(true);
      }
      expect(
        feed.entries.find((item: { id: string }) => item.id === activity.id)
          ?.block.turn.trace.detailsOmitted
      ).toBe(true);
      await expect(row(error.id)).toContainText(
        "Notification engine failed visibly."
      );
      const screenshot = `/tmp/dispatch-empty-turns-${width}.png`;
      await page.screenshot({
        path: screenshot,
        fullPage: true,
        animations: "disabled",
      });
      await test
        .info()
        .attach(`Empty wakeups omitted; error and activity retained ${width}`, {
          path: screenshot,
          contentType: "image/png",
        });

      // Content landing after an empty settlement restores that same row.
      await pool.query(
        `UPDATE blocks SET attachments = $2, updated_at = NOW() WHERE id = $1`,
        [
          active.id,
          JSON.stringify([
            {
              type: "code",
              code: "Late attachment restored",
              language: "text",
            },
          ]),
        ]
      );
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(row(active.id)).toContainText("Late attachment restored");
    } finally {
      await pool.end();
      await cleanupE2EAgents(request);
    }
  });
}
