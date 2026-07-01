import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";

import { MessageStore } from "../src/messages/store.js";
import { setupTestDb, teardownTestDb, runTestMigrations } from "./db/setup.js";

let pool: Pool;
let store: MessageStore;

const REPO = "/repo/msg-test";
const A = "agt_msg_a";
const B = "agt_msg_b";

beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
  store = new MessageStore(pool);
});

afterAll(async () => {
  await teardownTestDb();
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
      senderAgentId: B,
      recipientAgentId: A,
      senderName: "Bob",
      recipientName: "Alice",
      content: "hi alice",
      delivered: true,
      senderRepoRoot: REPO,
      recipientRepoRoot: REPO,
    });

    // A received one message ("hi alice") -> unread 1. A sent one -> not counted.
    expect(await store.countUnreadForAgent(A)).toBe(1);

    const cleared = await store.markReadForAgent(A);
    expect(cleared).toBe(1);
    expect(await store.countUnreadForAgent(A)).toBe(0);
    // Marking A read must not touch B's unread.
    expect(await store.countUnreadForAgent(B)).toBe(1);
  });
});
