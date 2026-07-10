import type { Pool } from "pg";

import { applyOps } from "../shared/whiteboard-builder.js";
import { getWhiteboard, saveWhiteboard } from "../shared/whiteboard-store.js";
import {
  simplifyElements,
  type WhiteboardOp,
  type WhiteboardScene,
  type WhiteboardGetResult,
  type WhiteboardUpdateResult,
} from "../shared/whiteboard.js";
import { resolveMediaDir } from "../shared/media.js";
import type { AgentManager } from "../agents/manager.js";
import type { PublishUiEvent } from "./mcp-handler-types.js";

type CreateWhiteboardHandlersDeps = {
  pool: Pool;
  mediaRoot: string;
  agentManager: AgentManager;
  publishUiEvent: PublishUiEvent;
};

export function createWhiteboardHandlers(deps: CreateWhiteboardHandlersDeps) {
  const { pool, mediaRoot, agentManager, publishUiEvent } = deps;

  return {
    async getWhiteboardForAgent(agentId: string): Promise<WhiteboardGetResult> {
      const row = await getWhiteboard(pool, agentId);
      const scene: WhiteboardScene = row?.scene ?? { records: [] };
      const records = scene.records ?? [];

      const agent = await agentManager.getAgent(agentId);
      let snapshotPath: string | null = null;
      if (agent) {
        const dir = resolveMediaDir(agentId, agent.mediaDir, mediaRoot);
        snapshotPath = `${dir}/whiteboard-snapshot.png`;
      }

      return {
        scene,
        version: row?.version ?? 0,
        elements: simplifyElements(records),
        snapshotPath,
      };
    },

    async updateWhiteboardForAgent(
      agentId: string,
      ops: WhiteboardOp[]
    ): Promise<WhiteboardUpdateResult> {
      const row = await getWhiteboard(pool, agentId);
      const currentScene: WhiteboardScene = row?.scene ?? { records: [] };
      const currentVersion = row?.version ?? null;

      const updatedScene = applyOps(currentScene, ops);
      const { version } = await saveWhiteboard(
        pool,
        agentId,
        updatedScene,
        currentVersion
      );

      publishUiEvent({
        type: "whiteboard.changed",
        agentId,
        source: "agent",
      } as never);

      return {
        version,
        elementCount: updatedScene.records.length,
      };
    },
  };
}
