import type { Pool } from "pg";
import { AcpDriver } from "../../src/agents/acp/driver.js";
import { engineSpecFor } from "../../src/agents/acp/engine-spec.js";
import { writeBackground } from "../../src/agents/acp/background-store.js";
import { createFakeAcpAgent } from "./fake-acp-agent.js";

/** Inert provider → pinned driver connection → durable projection. Never spawns. */
export async function backgroundFixture(
  pool: Pool,
  agentId: string,
  provider: "claude" | "codex",
  supported = true
) {
  const fake = createFakeAcpAgent({ backgroundTasks: supported });
  let writes = Promise.resolve();
  const driver = new AcpDriver({
    spawn: () => fake.child,
    resolveBinary: async (bin) => bin,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });
  driver.onEvent((event) => {
    if (event.type === "background" || event.type === "exit")
      writes = writes.then(() => writeBackground(pool, agentId, event));
  });
  const session = await driver.start({
    agentId,
    cwd: "/tmp",
    engine: engineSpecFor(provider, {
      claudeBin: "/tmp/inert-claude",
      codexBin: "/tmp/inert-codex",
      opencodeBin: "/tmp/inert-opencode",
    }),
    systemPromptAppend: null,
    mcp: { url: "http://127.0.0.1:1/inert", token: "inert" },
    sessionId: null,
    env: {},
  });
  await writes;
  return {
    async report(update: unknown, sessionId = session.sessionId) {
      fake.wireUpdate(sessionId, update);
      // Drain the in-process wire before waiting for its persistence queue.
      await new Promise((resolve) => setTimeout(resolve, 30));
      await writes;
    },
    async close() {
      await driver.stop(agentId);
      await writes;
    },
  };
}
