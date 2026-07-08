import path from "node:path";
import { stat } from "node:fs/promises";

import type { Pool } from "pg";

import type { AgentManager } from "../agents/manager.js";
import { resolveMediaDir } from "../shared/media.js";
import {
  simplifyElements,
  type WhiteboardGetResult,
  type WhiteboardUpdateResult,
} from "../shared/whiteboard.js";
import {
  loadWhiteboard,
  MAX_ELEMENTS,
  saveWhiteboard,
  WHITEBOARD_SNAPSHOT_FILENAME,
} from "../shared/whiteboard-store.js";
import {
  applyWhiteboardOps,
  type WhiteboardOp,
} from "../shared/whiteboard-builder.js";
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
    async getWhiteboard(agentId: string): Promise<WhiteboardGetResult> {
      const agent = await agentManager.getAgent(agentId);
      if (!agent) throw new Error("Agent not found.");

      const row = await loadWhiteboard(pool, agentId);
      const snapshotFile = path.join(
        resolveMediaDir(agentId, agent.mediaDir, mediaRoot),
        WHITEBOARD_SNAPSHOT_FILENAME
      );
      const snapshotStat = await stat(snapshotFile).catch(() => null);
      const snapshotPath = snapshotStat?.isFile() ? snapshotFile : null;
      return {
        elements: row ? simplifyElements(row.scene.elements) : [],
        version: row ? Number(row.version) : 0,
        updatedAt: row ? row.updated_at.toISOString() : null,
        updatedBy: row ? row.updated_by : null,
        snapshotPath,
        // The PNG is exported by a connected browser; agent-side edits (or a
        // closed tab) leave it depicting an older scene.
        snapshotStale:
          snapshotPath !== null &&
          row !== null &&
          snapshotStat !== null &&
          row.updated_at.getTime() > snapshotStat.mtime.getTime(),
      };
    },

    async updateWhiteboard(
      agentId: string,
      ops: WhiteboardOp[]
    ): Promise<WhiteboardUpdateResult> {
      const agent = await agentManager.getAgent(agentId);
      if (!agent) throw new Error("Agent not found.");

      // The user's editor saves concurrently; retry op application on top of
      // the fresh scene when the optimistic version check loses the race.
      for (let attempt = 0; attempt < 3; attempt++) {
        const row = await loadWhiteboard(pool, agentId);
        const baseVersion = row ? Number(row.version) : 0;
        const existing = row ? row.scene.elements : [];
        const result = applyWhiteboardOps(existing, ops);

        if (result.errors.length === ops.length) {
          // Every op failed — nothing changed, report without saving.
          return {
            version: baseVersion,
            created: [],
            errors: result.errors,
            warnings: result.warnings,
            elements: simplifyElements(existing),
          };
        }
        if (result.elements.length > MAX_ELEMENTS) {
          throw new Error(`Board is full (max ${MAX_ELEMENTS} elements).`);
        }

        const saved = await saveWhiteboard(
          pool,
          agentId,
          { elements: result.elements },
          baseVersion,
          "agent"
        );
        if (saved) {
          publishUiEvent({
            type: "whiteboard.changed",
            agentId,
            version: saved.version,
            source: "agent",
          });
          return {
            version: saved.version,
            created: result.created,
            errors: result.errors,
            warnings: result.warnings,
            elements: simplifyElements(result.elements),
          };
        }
      }
      throw new Error(
        "Whiteboard is being edited concurrently; try again in a moment."
      );
    },
  };
}
