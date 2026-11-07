import type { Pool } from "pg";
import {
  emptyBackground,
  projectBackground,
  type BackgroundEvent,
  type BackgroundSnapshot,
} from "./background-projection.js";

export async function readBackground(
  pool: Pool,
  agentId: string,
  detail?: string
): Promise<BackgroundSnapshot> {
  const result = await pool.query<{ snapshot: BackgroundSnapshot }>(
    "SELECT snapshot FROM agent_background_work WHERE agent_id = $1",
    [agentId]
  );
  const snapshot = result.rows[0]?.snapshot ?? emptyBackground();
  // Resolve origin IDs in one bounded query. Only the selected detail returns
  // existing bounded transcript output; the regularly polled list carries none.
  const origins = await pool.query<{
    generation: string;
    id: string;
    block_id: string | null;
    output: string | null;
  }>(
    `
    SELECT wanted.generation, wanted.id, turn.payload->>'blockId' AS block_id,
      CASE WHEN wanted.generation || ':' || wanted.id = $3
        THEN left(tool.payload->>'terminalOutput', 16000) ELSE NULL END AS output
    FROM jsonb_to_recordset($2::jsonb) AS wanted(id text, generation text, "toolCallId" text, "sessionId" text)
    JOIN agent_stream_events tool ON tool.agent_id = $1 AND tool.kind = 'tool_call' AND tool.key = wanted."toolCallId"
    JOIN LATERAL (SELECT payload FROM agent_stream_events
      WHERE agent_id = tool.agent_id AND kind = 'turn' AND seq <= tool.seq
      ORDER BY seq DESC LIMIT 1) turn ON turn.payload->>'sessionId' = wanted."sessionId"
    LIMIT 200`,
    [agentId, JSON.stringify(snapshot.items), detail ?? null]
  );
  const items = snapshot.items.map((item) => {
    const origin = origins.rows.find(
      (row) => row.generation === item.generation && row.id === item.id
    );
    return {
      ...item,
      ...(origin?.block_id ? { originBlockId: origin.block_id } : {}),
      ...(origin?.output ? { terminalOutput: origin.output } : {}),
    };
  });
  return { ...snapshot, items };
}

export async function writeBackground(
  pool: Pool,
  agentId: string,
  event: BackgroundEvent | { type: "exit" }
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Serialize with other lifecycle writers including the first insert.
    await client.query("SELECT id FROM agents WHERE id = $1 FOR UPDATE", [
      agentId,
    ]);
    const result = await client.query<{ snapshot: BackgroundSnapshot }>(
      "SELECT snapshot FROM agent_background_work WHERE agent_id = $1",
      [agentId]
    );
    const previous = result.rows[0]?.snapshot ?? emptyBackground();
    const snapshot =
      event.type === "exit"
        ? {
            ...previous,
            stale: true,
            items: previous.items.map((item) => ({ ...item, stale: true })),
          }
        : projectBackground(previous, event);
    await client.query(
      "INSERT INTO agent_background_work (agent_id, snapshot) VALUES ($1, $2::jsonb) ON CONFLICT (agent_id) DO UPDATE SET snapshot = EXCLUDED.snapshot",
      [agentId, JSON.stringify(snapshot)]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
