/**
 * Integration tests for human review feedback operations:
 * - Creating reviews with feedback items
 * - Resolving feedback items (dispatch_review_resolve)
 * - Adding thread messages (dispatch_review_add_message)
 * - Listing feedback items (dispatch_review_list_feedback)
 * - Ownership checks (agent_id and assigned_agent_id)
 */
import { beforeEach, describe, expect, it } from "vitest";

import { addThreadMessage } from "../src/agents/reviews.js";
import { AGENT_REVIEW_REPLY_MAX_CHARS } from "../src/shared/review-limits.js";
import { useInjectApp } from "./helpers/inject-app.js";

const ctx = useInjectApp();
let sessionCookie: string;

const AGENT_ID = "agt_reviewfb_01";
const OTHER_AGENT_ID = "agt_reviewfb_02";

beforeEach(async () => {
  await ctx.pool.query("DELETE FROM review_thread_messages");
  await ctx.pool.query("DELETE FROM review_feedback_items");
  await ctx.pool.query("DELETE FROM reviews");
  await ctx.pool.query("DELETE FROM agent_events");
  await ctx.pool.query("DELETE FROM agents");
  await ctx.pool.query("DELETE FROM sessions");
  sessionCookie = await ctx.sessionCookie();

  await ctx.pool.query(
    `INSERT INTO agents (id, name, type, status, cwd, full_access)
     VALUES ($1, 'review-agent', 'codex', 'running', '/tmp', false)`,
    [AGENT_ID]
  );
  await ctx.pool.query(
    `INSERT INTO agents (id, name, type, status, cwd, full_access)
     VALUES ($1, 'other-agent', 'codex', 'running', '/tmp', false)`,
    [OTHER_AGENT_ID]
  );
});

async function createReview(
  agentId: string,
  items: Array<{ comment: string; filePath?: string; startLine?: number }>
) {
  const response = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/agents/${agentId}/reviews`,
    headers: { cookie: sessionCookie, "content-type": "application/json" },
    payload: { items },
  });
  expect(response.statusCode).toBe(200);
  return response.json().review;
}

// ---------------------------------------------------------------------------
// POST /api/v1/agents/:id/reviews — create review
// ---------------------------------------------------------------------------
describe("POST /api/v1/agents/:id/reviews", () => {
  it("creates a review with feedback items", async () => {
    const review = await createReview(AGENT_ID, [
      { comment: "Fix this bug", filePath: "src/foo.ts", startLine: 10 },
      { comment: "General comment" },
    ]);

    expect(review.id).toBeTypeOf("number");
    expect(review.agentId).toBe(AGENT_ID);
    expect(review.reviewerType).toBe("human");
    expect(review.status).toBe("open");
    expect(review.items).toHaveLength(2);
    expect(review.items[0].filePath).toBe("src/foo.ts");
    expect(review.items[0].lineStart).toBe(10);
    expect(review.items[0].messages).toHaveLength(1);
    expect(review.items[0].messages[0].content.body).toBe("Fix this bug");
    expect(review.items[1].filePath).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/v1/agents/:id/reviews/items/:itemId — resolve feedback
// ---------------------------------------------------------------------------
describe("PATCH /api/v1/agents/:id/reviews/items/:itemId", () => {
  it("resolves a feedback item as fixed", async () => {
    const review = await createReview(AGENT_ID, [{ comment: "Fix this" }]);
    const itemId = review.items[0].id;

    const response = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/agents/${AGENT_ID}/reviews/items/${itemId}`,
      headers: { cookie: sessionCookie, "content-type": "application/json" },
      payload: { resolution: "fixed" },
    });

    expect(response.statusCode).toBe(200);
    const result = response.json();
    expect(result.item.id).toBe(itemId);
    expect(result.item.status).toBe("resolved");
    expect(result.item.resolution).toBe("fixed");
  });

  it("resolves a feedback item as dismissed with a note", async () => {
    const review = await createReview(AGENT_ID, [{ comment: "Do this" }]);
    const itemId = review.items[0].id;

    const response = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/agents/${AGENT_ID}/reviews/items/${itemId}`,
      headers: { cookie: sessionCookie, "content-type": "application/json" },
      payload: { resolution: "dismissed", note: "Not applicable" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().item.resolution).toBe("dismissed");
    expect(response.json().item.resolutionNote).toBe("Not applicable");
  });

  it("rejects unsupported review resolutions", async () => {
    const review = await createReview(AGENT_ID, [{ comment: "Refactor" }]);
    const response = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/agents/${AGENT_ID}/reviews/items/${review.items[0].id}`,
      headers: { cookie: sessionCookie, "content-type": "application/json" },
      payload: { resolution: "wont_fix" },
    });

    expect(response.statusCode).toBe(400);
  });

  it("updates review status to resolved when all items are resolved", async () => {
    const review = await createReview(AGENT_ID, [
      { comment: "Bug 1" },
      { comment: "Bug 2" },
    ]);

    for (const item of review.items) {
      await ctx.app.inject({
        method: "PATCH",
        url: `/api/v1/agents/${AGENT_ID}/reviews/items/${item.id}`,
        headers: { cookie: sessionCookie, "content-type": "application/json" },
        payload: { resolution: "fixed" },
      });
    }

    const reviewResponse = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/agents/${AGENT_ID}/reviews/${review.id}`,
      headers: { cookie: sessionCookie },
    });
    expect(reviewResponse.json().review.status).toBe("resolved");
  });

  it("sets review status to partially_resolved when some items are resolved", async () => {
    const review = await createReview(AGENT_ID, [
      { comment: "Bug 1" },
      { comment: "Bug 2" },
    ]);

    await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/agents/${AGENT_ID}/reviews/items/${review.items[0].id}`,
      headers: { cookie: sessionCookie, "content-type": "application/json" },
      payload: { resolution: "fixed" },
    });

    const reviewResponse = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/agents/${AGENT_ID}/reviews/${review.id}`,
      headers: { cookie: sessionCookie },
    });
    expect(reviewResponse.json().review.status).toBe("partially_resolved");
  });

  it("reopens a resolved feedback item", async () => {
    const review = await createReview(AGENT_ID, [{ comment: "Bug 1" }]);
    const itemId = review.items[0].id;

    await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/agents/${AGENT_ID}/reviews/items/${itemId}`,
      headers: { cookie: sessionCookie, "content-type": "application/json" },
      payload: { resolution: "fixed" },
    });
    const response = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/agents/${AGENT_ID}/reviews/items/${itemId}`,
      headers: { cookie: sessionCookie, "content-type": "application/json" },
      payload: { resolution: null },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().item.status).toBe("open");
    expect(response.json().item.resolution).toBeNull();
    const reviewResponse = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/agents/${AGENT_ID}/reviews/${review.id}`,
      headers: { cookie: sessionCookie },
    });
    expect(reviewResponse.json().review.status).toBe("open");
  });

  it("returns 404 for item belonging to different agent", async () => {
    const review = await createReview(AGENT_ID, [{ comment: "Private" }]);
    const itemId = review.items[0].id;

    const response = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/agents/${OTHER_AGENT_ID}/reviews/items/${itemId}`,
      headers: { cookie: sessionCookie, "content-type": "application/json" },
      payload: { resolution: "fixed" },
    });

    expect(response.statusCode).toBe(404);
  });

  it("allows assigned_agent_id to resolve items", async () => {
    const review = await createReview(AGENT_ID, [{ comment: "Fix this" }]);
    const itemId = review.items[0].id;

    // Manually set assigned_agent_id to OTHER_AGENT_ID
    await ctx.pool.query(
      "UPDATE reviews SET assigned_agent_id = $1 WHERE id = $2",
      [OTHER_AGENT_ID, review.id]
    );

    const response = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/agents/${OTHER_AGENT_ID}/reviews/items/${itemId}`,
      headers: { cookie: sessionCookie, "content-type": "application/json" },
      payload: { resolution: "fixed" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().item.resolution).toBe("fixed");
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/agents/:id/reviews/items/:itemId/messages — add message
// ---------------------------------------------------------------------------
describe("POST /api/v1/agents/:id/reviews/items/:itemId/messages", () => {
  it("adds a message to a feedback item thread", async () => {
    const review = await createReview(AGENT_ID, [{ comment: "Fix this" }]);
    const itemId = review.items[0].id;

    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/agents/${AGENT_ID}/reviews/items/${itemId}/messages`,
      headers: { cookie: sessionCookie, "content-type": "application/json" },
      payload: { body: "Working on it now" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().message.content.body).toBe("Working on it now");
  });

  it("returns 404 for item belonging to different agent", async () => {
    const review = await createReview(AGENT_ID, [{ comment: "Fix this" }]);
    const itemId = review.items[0].id;

    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/agents/${OTHER_AGENT_ID}/reviews/items/${itemId}/messages`,
      headers: { cookie: sessionCookie, "content-type": "application/json" },
      payload: { body: "Intruder" },
    });

    expect(response.statusCode).toBe(404);
  });

  it("allows assigned_agent_id to add messages", async () => {
    const review = await createReview(AGENT_ID, [{ comment: "Fix this" }]);
    const itemId = review.items[0].id;

    await ctx.pool.query(
      "UPDATE reviews SET assigned_agent_id = $1 WHERE id = $2",
      [OTHER_AGENT_ID, review.id]
    );

    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/agents/${OTHER_AGENT_ID}/reviews/items/${itemId}/messages`,
      headers: { cookie: sessionCookie, "content-type": "application/json" },
      payload: { body: "I can help too" },
    });

    expect(response.statusCode).toBe(200);
  });

  it("limits new agent replies to 600 characters without limiting humans", async () => {
    const review = await createReview(AGENT_ID, [{ comment: "Fix this" }]);
    const itemId = review.items[0].id;

    await expect(
      addThreadMessage(
        ctx.pool,
        itemId,
        AGENT_ID,
        "agent",
        "a".repeat(AGENT_REVIEW_REPLY_MAX_CHARS),
        AGENT_ID
      )
    ).resolves.not.toBeNull();

    await expect(
      addThreadMessage(
        ctx.pool,
        itemId,
        AGENT_ID,
        "agent",
        "a".repeat(AGENT_REVIEW_REPLY_MAX_CHARS + 1),
        AGENT_ID
      )
    ).rejects.toThrow("600 characters or fewer");

    await expect(
      addThreadMessage(
        ctx.pool,
        itemId,
        AGENT_ID,
        "human",
        "h".repeat(AGENT_REVIEW_REPLY_MAX_CHARS + 1)
      )
    ).resolves.not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/agents/:id/reviews/feedback-items — list feedback
// ---------------------------------------------------------------------------
describe("GET /api/v1/agents/:id/reviews/feedback-items", () => {
  it("lists all feedback items for an agent", async () => {
    await createReview(AGENT_ID, [
      { comment: "Bug 1", filePath: "a.ts", startLine: 5 },
      { comment: "Bug 2" },
    ]);

    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/agents/${AGENT_ID}/reviews/feedback-items`,
      headers: { cookie: sessionCookie },
    });

    expect(response.statusCode).toBe(200);
    const { items } = response.json();
    expect(items).toHaveLength(2);
    expect(items[0].filePath).toBe("a.ts");
    expect(items[0].messages).toHaveLength(1);
    expect(items[0].messages[0].content.body).toBe("Bug 1");
  });

  it("returns empty array for agent with no reviews", async () => {
    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/agents/${AGENT_ID}/reviews/feedback-items`,
      headers: { cookie: sessionCookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().items).toEqual([]);
  });

  it("includes thread messages from both humans and agents", async () => {
    const review = await createReview(AGENT_ID, [{ comment: "Fix this" }]);
    const itemId = review.items[0].id;

    await ctx.app.inject({
      method: "POST",
      url: `/api/v1/agents/${AGENT_ID}/reviews/items/${itemId}/messages`,
      headers: { cookie: sessionCookie, "content-type": "application/json" },
      payload: { body: "Reply from agent" },
    });

    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/agents/${AGENT_ID}/reviews/feedback-items`,
      headers: { cookie: sessionCookie },
    });

    const { items } = response.json();
    expect(items[0].messages).toHaveLength(2);
    expect(items[0].messages[0].content.body).toBe("Fix this");
    expect(items[0].messages[1].content.body).toBe("Reply from agent");
  });

  it("does not return items from other agents", async () => {
    await createReview(AGENT_ID, [{ comment: "Agent 1 review" }]);
    await createReview(OTHER_AGENT_ID, [{ comment: "Agent 2 review" }]);

    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/agents/${AGENT_ID}/reviews/feedback-items`,
      headers: { cookie: sessionCookie },
    });

    expect(response.json().items).toHaveLength(1);
    expect(response.json().items[0].messages[0].content.body).toBe(
      "Agent 1 review"
    );
  });
});
