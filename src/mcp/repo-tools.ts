import path from "node:path";
import { readFile } from "node:fs/promises";

import { runCommand } from "../lib/run-command.js";

const REPO_TOOL_MANIFEST_PATH = path.join(".dispatch", "tools.json");
const REPO_TOOL_PREFIX = "repo_";
const BUILTIN_TOOL_NAMES = new Set([
  "create_worktree",
  "cleanup_worktree",
  "create_pr",
  "enable_pr_automerge",
  "merge_pr_now",
  "get_pr_status",
  "dispatch_event",
  "dispatch_share"
]);

type RepoToolFile = {
  tools?: unknown;
};

export type RepoToolParam = {
  name: string;
  type: "string" | "boolean";
  flag: string;
  description: string;
};

type RepoToolConfig = {
  name: string;
  description: string;
  command: string[];
  params?: RepoToolParam[];
};

export type RepoToolResult = {
  agentId: string;
  repoRoot: string;
  command: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  message: string;
};

export type RepoToolDefinition = {
  name: string;
  description: string;
  params?: RepoToolParam[];
  run: (context: { agentId: string; repoRoot: string; params?: Record<string, unknown> }) => Promise<RepoToolResult>;
};

export async function loadRepoTools(repoRoot: string): Promise<RepoToolDefinition[]> {
  const config = await readRepoToolFile(path.join(repoRoot, REPO_TOOL_MANIFEST_PATH));
  const rawTools = Array.isArray(config?.tools) ? config.tools : [];

  return rawTools.map((rawTool, index) => {
    const tool = parseRepoTool(rawTool, index);
    const prefixedName = `${REPO_TOOL_PREFIX}${tool.name}`;
    return {
      name: prefixedName,
      description: tool.description,
      params: tool.params,
      run: async ({ agentId, repoRoot: currentRepoRoot, params }) => {
        const [command, ...args] = tool.command;

        // Append CLI flags from params
        if (tool.params && params) {
          for (const param of tool.params) {
            const value = params[param.name];
            if (value === undefined || value === null) continue;
            if (param.type === "boolean" && value === true) {
              args.push(param.flag);
            } else if (param.type === "string" && typeof value === "string" && value) {
              args.push(param.flag, value);
            }
          }
        }

        const result = await runCommand(command, args, {
          cwd: currentRepoRoot,
          env: {
            DISPATCH_AGENT_ID: agentId,
            HOSTESS_AGENT_ID: agentId
          }
        });

        return {
          agentId,
          repoRoot: currentRepoRoot,
          command: tool.command,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          message: result.stdout || `Ran ${prefixedName} in ${currentRepoRoot}.`
        };
      }
    };
  });
}

async function readRepoToolFile(filePath: string): Promise<RepoToolFile | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as RepoToolFile;
  } catch {
    return null;
  }
}

function parseRepoTool(value: unknown, index: number): RepoToolConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid repo tool at index ${index}.`);
  }

  const rawTool = value as Record<string, unknown>;
  const rawName = typeof rawTool.name === "string" ? rawTool.name.trim() : "";
  const description = typeof rawTool.description === "string" ? rawTool.description.trim() : "";
  const command = Array.isArray(rawTool.command) && rawTool.command.every((part) => typeof part === "string")
    ? rawTool.command.map((part) => part.trim()).filter(Boolean)
    : [];

  if (!rawName) {
    throw new Error(`Repo tool at index ${index} must have a non-empty name.`);
  }
  // Strip dots from tool names — MCP clients (e.g. Claude) don't support dots in tool names.
  const name = rawName.replaceAll(".", "_");
  const prefixedName = `${REPO_TOOL_PREFIX}${name}`;
  if (BUILTIN_TOOL_NAMES.has(prefixedName)) {
    throw new Error(`Repo tool "${name}" collides with a built-in Dispatch MCP tool when prefixed as "${prefixedName}".`);
  }
  if (!description) {
    throw new Error(`Repo tool "${name}" must include a description.`);
  }
  if (command.length === 0) {
    throw new Error(`Repo tool "${name}" must include a non-empty command array.`);
  }

  const params = parseRepoToolParams(rawTool.params);

  return { name, description, command, params };
}

function parseRepoToolParams(raw: unknown): RepoToolParam[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;

  return raw.map((entry, i) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`Invalid param at index ${i}.`);
    }
    const p = entry as Record<string, unknown>;
    const name = typeof p.name === "string" ? p.name.trim() : "";
    const type = p.type === "string" || p.type === "boolean" ? p.type : "";
    const flag = typeof p.flag === "string" ? p.flag.trim() : "";
    const description = typeof p.description === "string" ? p.description.trim() : "";

    if (!name || !type || !flag) {
      throw new Error(`Param at index ${i} must have name, type (string|boolean), and flag.`);
    }
    return { name, type, flag, description };
  });
}
