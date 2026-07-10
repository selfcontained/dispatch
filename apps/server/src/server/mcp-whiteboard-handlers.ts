import path from "node:path";
import { rm, stat } from "node:fs/promises";

import type { Pool } from "pg";

import type { AgentManager } from "../agents/manager.js";
import { resolveMediaDir } from "../shared/media.js";
import {
  simplifyElements,
  type WhiteboardGetResult,
  type WhiteboardUpdateResult,
} from "../shared/whiteboard.js";
import {
  EMPTY_SCENE,
  loadWhiteboard,
  MAX_ELEMENTS,
  saveWhiteboard,
  WHITEBOARD_SNAPSHOT_FILENAME,
} from "../shared/whiteboard-store.js";
import type { PublishUiEvent } from "./mcp-handler-types.js";

type CreateWhiteboardHandlersDeps = {
  pool: Pool;
  mediaRoot: string;
  agentManager: AgentManager;
  publishUiEvent: PublishUiEvent;
};

type RawElement = Record<string, unknown>;

function hasRequiredFields(
  el: unknown
): el is RawElement & { id: string; type: string } {
  if (typeof el !== "object" || el === null) return false;
  const obj = el as RawElement;
  return typeof obj.id === "string" && typeof obj.type === "string";
}

function mergeElements(
  existing: unknown[],
  incoming: unknown[],
  deleteIds: string[]
): { elements: unknown[]; addedIds: string[]; updatedIds: string[] } {
  const deleteSet = new Set(deleteIds);
  const existingMap = new Map<string, unknown>();
  for (const el of existing) {
    if (typeof el === "object" && el !== null) {
      const id = (el as RawElement).id;
      if (typeof id === "string") {
        existingMap.set(id, el);
      }
    }
  }

  const addedIds: string[] = [];
  const updatedIds: string[] = [];

  for (const el of incoming) {
    if (!hasRequiredFields(el)) continue;
    if (existingMap.has(el.id)) {
      updatedIds.push(el.id);
    } else {
      addedIds.push(el.id);
    }
    existingMap.set(el.id, el);
  }

  for (const id of deleteSet) {
    if (existingMap.has(id)) {
      existingMap.delete(id);
    }
  }

  return {
    elements: Array.from(existingMap.values()),
    addedIds,
    updatedIds,
  };
}

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
        snapshotStale:
          snapshotPath !== null &&
          row !== null &&
          snapshotStat !== null &&
          row.updated_at.getTime() > snapshotStat.mtime.getTime(),
      };
    },

    async updateWhiteboard(
      agentId: string,
      elements: unknown[],
      deleteIds: string[]
    ): Promise<WhiteboardUpdateResult> {
      const agent = await agentManager.getAgent(agentId);
      if (!agent) throw new Error("Agent not found.");

      for (let attempt = 0; attempt < 3; attempt++) {
        const row = await loadWhiteboard(pool, agentId);
        const baseVersion = row ? Number(row.version) : 0;
        const existing = row ? row.scene.elements : [];

        const merged = mergeElements(existing, elements, deleteIds);

        if (merged.elements.length > MAX_ELEMENTS) {
          throw new Error(`Board is full (max ${MAX_ELEMENTS} elements).`);
        }

        const saved = await saveWhiteboard(
          pool,
          agentId,
          { elements: merged.elements },
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
            elementCount: merged.elements.length,
            addedIds: merged.addedIds,
            updatedIds: merged.updatedIds,
            deletedIds: deleteIds.filter((id) =>
              existing.some(
                (el) =>
                  typeof el === "object" &&
                  el !== null &&
                  (el as RawElement).id === id
              )
            ),
            elements: simplifyElements(merged.elements),
          };
        }
      }
      throw new Error(
        "Whiteboard is being edited concurrently; try again in a moment."
      );
    },

    async clearWhiteboard(agentId: string): Promise<void> {
      const agent = await agentManager.getAgent(agentId);
      if (!agent) throw new Error("Agent not found.");

      for (let attempt = 0; attempt < 3; attempt++) {
        const row = await loadWhiteboard(pool, agentId);
        const baseVersion = row ? Number(row.version) : 0;
        const saved = await saveWhiteboard(
          pool,
          agentId,
          EMPTY_SCENE,
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
          const snapshotFile = path.join(
            resolveMediaDir(agentId, agent.mediaDir, mediaRoot),
            WHITEBOARD_SNAPSHOT_FILENAME
          );
          await rm(snapshotFile, { force: true });
          return;
        }
      }
      throw new Error(
        "Whiteboard is being edited concurrently; try again in a moment."
      );
    },
  };
}
