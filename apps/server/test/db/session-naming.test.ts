import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { AgentManager } from "../../src/agents/manager.js";
import { nameNewSession } from "../../src/agents/session-naming.js";
import { runTestMigrations, setupTestDb, teardownTestDb } from "./setup.js";
import pino from "pino";

let pool: Pool;
beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
});
afterAll(teardownTestDb);

it("uses the real claim and normal same-name rename to defeat a late title", async () => {
  await pool.query(
    "INSERT INTO agents(id,name,status,cwd) VALUES('naming-race','Fallback','stopped','/tmp')"
  );
  await pool.query(
    "INSERT INTO settings(key,value) VALUES('routing_api_key','mock-key'),('dispatch_ai_enabled','true'),('session_naming_mode','active') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value"
  );
  const manager = new AgentManager(pool, pino({ level: "silent" }), {
    host: "127.0.0.1",
    port: 0,
    databaseUrl: "",
    authToken: "test-token",
    filesRoot: "/tmp/dispatch-naming-test-files",
    dispatchBinDir: "/tmp",
    codexBin: "echo",
    claudeBin: "echo",
    opencodeBin: "echo",
    agentRuntime: "inert",
    tls: null,
  });
  let release!: (value: Response) => void;
  const transport = vi.fn<typeof fetch>().mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      })
  );
  const publish = vi.fn();
  const first = nameNewSession(
    pool,
    "naming-race",
    "Topic",
    publish,
    transport
  );
  await vi.waitFor(() => expect(transport).toHaveBeenCalledOnce());
  await nameNewSession(pool, "naming-race", "Topic", publish, transport);
  await manager.renameAgent("naming-race", "Fallback");
  release(
    new Response(
      JSON.stringify({
        status: "completed",
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: JSON.stringify({ title: "Generated session topic" }),
              },
            ],
          },
        ],
      })
    )
  );
  await first;
  expect(
    (
      await pool.query(
        "SELECT name,name_revision,naming_requested FROM agents WHERE id='naming-race'"
      )
    ).rows[0]
  ).toEqual({ name: "Fallback", name_revision: 1, naming_requested: true });
  expect(transport).toHaveBeenCalledOnce();
  expect(publish).not.toHaveBeenCalled();
});
