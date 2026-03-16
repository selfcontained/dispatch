import path from "node:path";
import { readFile } from "node:fs/promises";

import { runCommand } from "../lib/run-command.js";

const REPO_TOOL_MANIFEST_PATH = path.join(".dispatch", "tools.json");
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

type RepoToolConfig = {
  name: string;
  description: string;
  command: string[];
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
  run: (context: { agentId: string; repoRoot: string }) => Promise<RepoToolResult>;
};

export async function loadRepoTools(repoRoot: string): Promise<RepoToolDefinition[]> {
  const config = await readRepoToolFile(path.join(repoRoot, REPO_TOOL_MANIFEST_PATH));
  const rawTools = Array.isArray(config?.tools) ? config.tools : [];

  return rawTools.map((rawTool, index) => {
    const tool = parseRepoTool(rawTool, index);
    return {
      name: tool.name,
      description: tool.description,
      run: async ({ agentId, repoRoot: currentRepoRoot }) => {
        const [command, ...args] = tool.command;
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
          message: result.stdout || `Ran ${tool.name} in ${currentRepoRoot}.`
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
  const name = typeof rawTool.name === "string" ? rawTool.name.trim() : "";
  const description = typeof rawTool.description === "string" ? rawTool.description.trim() : "";
  const command = Array.isArray(rawTool.command) && rawTool.command.every((part) => typeof part === "string")
    ? rawTool.command.map((part) => part.trim()).filter(Boolean)
    : [];

  if (!name.startsWith("project.")) {
    throw new Error(`Repo tool "${name || `index ${index}`}" must start with "project.".`);
  }
  if (BUILTIN_TOOL_NAMES.has(name)) {
    throw new Error(`Repo tool "${name}" collides with a built-in Dispatch MCP tool.`);
  }
  if (!description) {
    throw new Error(`Repo tool "${name}" must include a description.`);
  }
  if (command.length === 0) {
    throw new Error(`Repo tool "${name}" must include a non-empty command array.`);
  }

  return { name, description, command };
}
