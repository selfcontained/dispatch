import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import type { NotifyInput } from "./server.js";
import { jsonText, LIST_STRING_MAX, truncateLongStrings } from "./response.js";
import { toToolError } from "./tool-error.js";

/**
 * One row of a file listing. `ownerAgentId` is always present: a listing can
 * mix owners once family reads exist, so every row says whose it is.
 */
export type ListedFileItem = {
  ownerAgentId: string;
  fileName: string;
  filePath: string;
  source: string;
  description: string | null;
  sizeBytes: number;
  createdAt: string;
};

export type SetWorkspaceResult = {
  workspacePath: string;
  moved: boolean;
  repoRoot: string | null;
  branch: string | null;
  baseBranch: string | null;
};

export type AgentLifecycleContext = {
  agentId: string;
  renameSession?: (
    agentId: string,
    name: string
  ) => Promise<{ id: string; name: string }>;
  setWorkspace?: (
    agentId: string,
    input: { path: string | null; baseBranch?: string | null }
  ) => Promise<SetWorkspaceResult>;
  sendNotify?: (
    agentId: string,
    input: NotifyInput
  ) => Promise<{
    sent: boolean;
    reason?: string;
  }>;
  listFiles?: (
    agentId: string,
    opts: { source?: string; ownerAgentId?: string }
  ) => Promise<ListedFileItem[]>;
  deleteFile?: (agentId: string, fileName: string) => Promise<void>;
};

export function registerAgentLifecycleTools(
  server: McpServer,
  allowed: Set<string>,
  context: AgentLifecycleContext
): void {
  const { agentId } = context;

  // ── rename_session ───────────────────────────────────────
  if (allowed.has("rename_session") && context.renameSession) {
    const renameSession = context.renameSession;

    server.registerTool(
      "rename_session",
      {
        description:
          "Update the current session's display name. Use this to rename a default-generated session to a short goal or topic, or when the user explicitly asks for a rename.",
        inputSchema: {
          name: z
            .string()
            .min(1)
            .max(120)
            .describe("New session display name."),
        },
      },
      async (args) => {
        try {
          const result = await renameSession(agentId, args.name);
          return {
            content: [
              { type: "text", text: `Renamed session to \"${result.name}\".` },
            ],
            structuredContent: result,
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }

  // ── set_workspace ────────────────────────────────────────
  if (allowed.has("set_workspace") && context.setWorkspace) {
    const setWorkspace = context.setWorkspace;

    server.registerTool(
      "set_workspace",
      {
        description:
          "Tell Dispatch which directory you are working in when it is no longer the one you launched in — for example a git worktree you created yourself, or a different repo. Dispatch's diff view, branch, repo tools and brain follow it; your shell's working directory does not change. Omit path to return to the launch directory.",
        inputSchema: {
          path: z
            .string()
            .min(1)
            .optional()
            .describe(
              "Absolute path of the directory you now work in. Inside a git checkout, its root is used."
            ),
          baseBranch: z
            .string()
            .min(1)
            .optional()
            .describe(
              "Branch the diff compares against. Defaults to the launch base in the same repo, else the repo's default branch."
            ),
        },
      },
      async (args) => {
        try {
          const result = await setWorkspace(agentId, {
            path: args.path ?? null,
            baseBranch: args.baseBranch ?? null,
          });
          const where = result.branch
            ? `${result.workspacePath} (${result.branch}${result.baseBranch ? ` vs ${result.baseBranch}` : ""})`
            : result.workspacePath;
          return {
            content: [
              {
                type: "text",
                text: result.moved
                  ? `Workspace set to ${where}.`
                  : `Workspace is back on the launch directory ${where}.`,
              },
            ],
            structuredContent: result,
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }

  // ── notify ───────────────────────────────────────────────
  // ── list_files ──────────────────────────────────────────
  if (allowed.has("list_files") && context.listFiles) {
    const listFiles = context.listFiles;

    server.registerTool(
      "list_files",
      {
        description:
          "List files shared with or by this agent, or by its parent or one of its direct children when ownerAgentId is supplied (read-only; an archived one still lists). Returns metadata only — use file reading tools to access content via filePath.",
        inputSchema: {
          source: z
            .string()
            .optional()
            .describe(
              'Optional source filter (e.g. "user", "screenshot", "text", "simulator", "stream"). Omit to list all files.'
            ),
          ownerAgentId: z
            .string()
            .min(1)
            .optional()
            .describe(
              "Whose files to list: omit for your own, or pass your parent's or a direct child's id (see list_agents). Any other agent reports as not found."
            ),
        },
      },
      async (args) => {
        try {
          const items = await listFiles(agentId, {
            source: args.source,
            ownerAgentId: args.ownerAgentId,
          });
          return {
            content: [{ type: "text" as const, text: jsonText(items) }],
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }

  if (allowed.has("delete_file") && context.deleteFile) {
    const deleteFile = context.deleteFile;
    server.registerTool(
      "delete_file",
      {
        description:
          "Permanently remove one of this agent's shared files. Call list_files first to identify the exact fileName. This removes both the stored file and its Dispatch file record.",
        inputSchema: {
          fileName: z
            .string()
            .describe("Exact fileName returned by list_files."),
        },
      },
      async (args) => {
        try {
          await deleteFile(agentId, args.fileName);
          return {
            content: [
              { type: "text", text: `Deleted file \"${args.fileName}\".` },
            ],
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }
}
