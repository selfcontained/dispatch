import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { Pool } from "pg";

import { MessageStore } from "../src/messages/store.js";
import { setupTestDb, teardownTestDb, runTestMigrations } from "./db/setup.js";

let pool: Pool;
let store: MessageStore;

const REPO = "/repo/msg-test";
const A = "agt_msg_a";
const B = "agt_msg_b";
const C = "agt_msg_c";

beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
  store = new MessageStore(pool);
});

afterAll(async () => {
  await teardownTestDb();
});

beforeEach(async () => {
  await pool.query("DELETE FROM agent_messages");
});

describe("MessageStore", () => {
  it("inserts and lists messages for both participants", async () => {
    const inserted = await store.insertMessage({
      senderAgentId: A,
      recipientAgentId: B,
      senderName: "Alice",
      recipientName: "Bob",
      content: "hello bob",
      delivered: true,
      senderRepoRoot: REPO,
      recipientRepoRoot: REPO,
    });
    expect(inserted.id).toBeTruthy();
    expect(inserted.readAt).toBeNull();
    expect(inserted.delivered).toBe(true);

    const forSender = await store.listForAgent(A);
    const forRecipient = await store.listForAgent(B);
    expect(forSender.map((m) => m.content)).toContain("hello bob");
    expect(forRecipient.map((m) => m.content)).toContain("hello bob");
  });

  it("counts and clears unread for the recipient only", async () => {
    await store.insertMessage({
      senderAgentId: A,
      recipientAgentId: B,
      senderName: "Alice",
      recipientName: "Bob",
      content: "first",
      delivered: true,
      senderRepoRoot: REPO,
      recipientRepoRoot: REPO,
    });
    await store.insertMessage({
      senderAgentId: B,
      recipientAgentId: A,
      senderName: "Bob",
      recipientName: "Alice",
      content: "hi alice",
      delivered: true,
      senderRepoRoot: REPO,
      recipientRepoRoot: REPO,
    });

    expect(await store.countUnreadForAgent(A)).toBe(1);

    const cleared = await store.markReadForAgent(A);
    expect(cleared).toBe(1);
    expect(await store.countUnreadForAgent(A)).toBe(0);
    expect(await store.countUnreadForAgent(B)).toBe(1);
  });

  describe("listForAgent", () => {
    it("returns messages in chronological ascending order", async () => {
      for (let i = 1; i <= 5; i++) {
        await store.insertMessage({
          senderAgentId: A,
          recipientAgentId: B,
          senderName: "Alice",
          recipientName: "Bob",
          content: `msg-${i}`,
          delivered: true,
          senderRepoRoot: REPO,
          recipientRepoRoot: REPO,
        });
      }

      const messages = await store.listForAgent(B);
      const contents = messages.map((m) => m.content);
      expect(contents).toEqual(["msg-1", "msg-2", "msg-3", "msg-4", "msg-5"]);
    });

    it("returns empty array for agent with no messages", async () => {
      const messages = await store.listForAgent("agt_nonexistent");
      expect(messages).toEqual([]);
    });

    it("includes both sent and received messages", async () => {
      await store.insertMessage({
        senderAgentId: A,
        recipientAgentId: B,
        senderName: "Alice",
        recipientName: "Bob",
        content: "from-a",
        delivered: true,
        senderRepoRoot: REPO,
        recipientRepoRoot: REPO,
      });
      await store.insertMessage({
        senderAgentId: B,
        recipientAgentId: A,
        senderName: "Bob",
        recipientName: "Alice",
        content: "from-b",
        delivered: true,
        senderRepoRoot: REPO,
        recipientRepoRoot: REPO,
      });

      const forA = await store.listForAgent(A);
      expect(forA.map((m) => m.content)).toEqual(["from-a", "from-b"]);
    });

    it("does not include messages between other agents", async () => {
      await store.insertMessage({
        senderAgentId: B,
        recipientAgentId: C,
        senderName: "Bob",
        recipientName: "Carol",
        content: "not for A",
        delivered: true,
        senderRepoRoot: REPO,
        recipientRepoRoot: REPO,
      });

      const forA = await store.listForAgent(A);
      expect(forA).toEqual([]);
    });

    it("caps results at 500 most recent messages", async () => {
      const inserts = [];
      for (let i = 1; i <= 510; i++) {
        inserts.push(
          pool.query(
            `INSERT INTO agent_messages
               (id, sender_agent_id, recipient_agent_id, sender_name, recipient_name,
                content, delivered, sender_repo_root, recipient_repo_root, created_at)
             VALUES (gen_random_uuid(), $1, $2, 'A', 'B', $3, true, $4, $4,
                     '2020-01-01'::timestamp + ($5 || ' seconds')::interval)`,
            [A, B, `bulk-${i}`, REPO, i]
          )
        );
      }
      await Promise.all(inserts);

      const messages = await store.listForAgent(A);
      expect(messages).toHaveLength(500);
      expect(messages[0].content).toBe("bulk-11");
      expect(messages[499].content).toBe("bulk-510");
    });
  });

  describe("insertMessage", () => {
    it("stores undelivered messages with delivered=false", async () => {
      const msg = await store.insertMessage({
        senderAgentId: A,
        recipientAgentId: B,
        senderName: "Alice",
        recipientName: "Bob",
        content: "failed delivery",
        delivered: false,
        senderRepoRoot: REPO,
        recipientRepoRoot: REPO,
      });
      expect(msg.delivered).toBe(false);

      const list = await store.listForAgent(B);
      expect(list.find((m) => m.content === "failed delivery")?.delivered).toBe(
        false
      );
    });

    it("allows null repo roots for cross-repo messages", async () => {
      const msg = await store.insertMessage({
        senderAgentId: A,
        recipientAgentId: B,
        senderName: "Alice",
        recipientName: "Bob",
        content: "cross-repo",
        delivered: true,
        senderRepoRoot: "/repo/one",
        recipientRepoRoot: null,
      });
      expect(msg.senderRepoRoot).toBe("/repo/one");
      expect(msg.recipientRepoRoot).toBeNull();
    });

    it("generates a unique id for each message", async () => {
      const m1 = await store.insertMessage({
        senderAgentId: A,
        recipientAgentId: B,
        senderName: "Alice",
        recipientName: "Bob",
        content: "one",
        delivered: true,
        senderRepoRoot: REPO,
        recipientRepoRoot: REPO,
      });
      const m2 = await store.insertMessage({
        senderAgentId: A,
        recipientAgentId: B,
        senderName: "Alice",
        recipientName: "Bob",
        content: "two",
        delivered: true,
        senderRepoRoot: REPO,
        recipientRepoRoot: REPO,
      });
      expect(m1.id).not.toBe(m2.id);
    });
  });

  describe("countUnreadForAgent", () => {
    it("returns 0 for agent with no messages", async () => {
      expect(await store.countUnreadForAgent("agt_nobody")).toBe(0);
    });

    it("does not count sent messages as unread", async () => {
      await store.insertMessage({
        senderAgentId: A,
        recipientAgentId: B,
        senderName: "Alice",
        recipientName: "Bob",
        content: "sent by A",
        delivered: true,
        senderRepoRoot: REPO,
        recipientRepoRoot: REPO,
      });
      expect(await store.countUnreadForAgent(A)).toBe(0);
    });

    it("does not count already-read messages", async () => {
      await store.insertMessage({
        senderAgentId: B,
        recipientAgentId: A,
        senderName: "Bob",
        recipientName: "Alice",
        content: "will be read",
        delivered: true,
        senderRepoRoot: REPO,
        recipientRepoRoot: REPO,
      });
      await store.markReadForAgent(A);

      await store.insertMessage({
        senderAgentId: B,
        recipientAgentId: A,
        senderName: "Bob",
        recipientName: "Alice",
        content: "new unread",
        delivered: true,
        senderRepoRoot: REPO,
        recipientRepoRoot: REPO,
      });
      expect(await store.countUnreadForAgent(A)).toBe(1);
    });
  });

  describe("markReadForAgent", () => {
    it("returns 0 when agent has no unread messages", async () => {
      expect(await store.markReadForAgent("agt_nobody")).toBe(0);
    });

    it("is idempotent — second call returns 0", async () => {
      await store.insertMessage({
        senderAgentId: B,
        recipientAgentId: A,
        senderName: "Bob",
        recipientName: "Alice",
        content: "mark me",
        delivered: true,
        senderRepoRoot: REPO,
        recipientRepoRoot: REPO,
      });

      expect(await store.markReadForAgent(A)).toBe(1);
      expect(await store.markReadForAgent(A)).toBe(0);
    });

    it("only marks messages where agent is the recipient", async () => {
      await store.insertMessage({
        senderAgentId: A,
        recipientAgentId: B,
        senderName: "Alice",
        recipientName: "Bob",
        content: "for B",
        delivered: true,
        senderRepoRoot: REPO,
        recipientRepoRoot: REPO,
      });

      const marked = await store.markReadForAgent(A);
      expect(marked).toBe(0);
      expect(await store.countUnreadForAgent(B)).toBe(1);
    });
  });
});
