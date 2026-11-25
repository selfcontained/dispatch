import path from "node:path";

export const REPO_TOOL_MANIFEST_PATH = path.join(".dispatch", "tools.json");

const REPO_TOOL_PREFIX = "repo_";
const BUILTIN_TOOL_NAMES = new Set([
  "post",
  "update",
  "react",
  "get_review",
  "get_message",
  "share_message",
  "get_thread",
  "get_conversation_context",
]);

type RepoToolFile = {
  tools?: unknown;
  hooks?: unknown;
};

export type RepoHookDefinition = {
  command: string[];
  description?: string;
};

export type RepoHooks = {
  stop?: RepoHookDefinition;
};

export type RepoToolParam = {
  name: string;
  type: "string" | "boolean";
  flag: string;
  description: string;
};

export type RepoToolScope = "agent" | "reviewer" | "job";

type RepoToolConfig = {
  name: string;
  description: string;
  command: string[];
  params?: RepoToolParam[];
  scope?: RepoToolScope[];
};

export type RepoToolResult = {
  agentId: string;
  repoRoot: string;
  command: string[];
  exitCode: number;
  truncated?: boolean;
  stdout: string;
  stderr: string;
  message: string;
};

export type RepoToolDefinition = {
  name: string;
  description: string;
  params?: RepoToolParam[];
  scope?: RepoToolScope[];
  run: (context: {
    agentId: string;
    repoRoot: string;
    params?: Record<string, unknown>;
    signal?: AbortSignal;
  }) => Promise<RepoToolResult>;
};

export function parseRepoTools(
  config: RepoToolFile | null,
  execute: (
    command: string[],
    cwd: string,
    agentId: string,
    signal?: AbortSignal
  ) => Promise<{
    exitCode: number;
    truncated?: boolean;
    stdout: string;
    stderr: string;
  }>
): RepoToolDefinition[] {
  const rawTools = Array.isArray(config?.tools) ? config.tools : [];

  return rawTools.map((rawTool, index) => {
    const tool = parseRepoTool(rawTool, index);
    const prefixedName = `${REPO_TOOL_PREFIX}${tool.name}`;
    return {
      name: prefixedName,
      description: tool.description,
      params: tool.params,
      scope: tool.scope,
      run: async ({ agentId, repoRoot: currentRepoRoot, params, signal }) => {
        const [command, ...args] = tool.command;

        // Append CLI flags from params
        if (tool.params && params) {
          for (const param of tool.params) {
            const value = params[param.name];
            if (value === undefined || value === null) continue;
            if (param.type === "boolean" && value === true) {
              args.push(param.flag);
            } else if (
              param.type === "string" &&
              typeof value === "string" &&
              value
            ) {
              args.push(param.flag, value);
            }
          }
        }

        const result = await execute(
          [command, ...args],
          currentRepoRoot,
          agentId,
          signal
        );

        return {
          agentId,
          repoRoot: currentRepoRoot,
          command: tool.command,
          exitCode: result.exitCode,
          ...(result.truncated !== undefined && {
            truncated: result.truncated,
          }),
          stdout: result.stdout,
          stderr: result.stderr,
          message:
            result.stdout || `Ran ${prefixedName} in ${currentRepoRoot}.`,
        };
      },
    };
  });
}

export function parseRepoToolFile(content: string | null): RepoToolFile | null {
  try {
    return content === null ? null : JSON.parse(content);
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
  const description =
    typeof rawTool.description === "string" ? rawTool.description.trim() : "";
  const command =
    Array.isArray(rawTool.command) &&
    rawTool.command.every((part) => typeof part === "string")
      ? rawTool.command.map((part) => part.trim()).filter(Boolean)
      : [];

  if (!rawName) {
    throw new Error(`Repo tool at index ${index} must have a non-empty name.`);
  }
  // Strip dots from tool names — MCP clients (e.g. Claude) don't support dots in tool names.
  const name = rawName.replaceAll(".", "_");
  const prefixedName = `${REPO_TOOL_PREFIX}${name}`;
  if (BUILTIN_TOOL_NAMES.has(prefixedName)) {
    throw new Error(
      `Repo tool "${name}" collides with a built-in Dispatch MCP tool when prefixed as "${prefixedName}".`
    );
  }
  if (!description) {
    throw new Error(`Repo tool "${name}" must include a description.`);
  }
  if (command.length === 0) {
    throw new Error(
      `Repo tool "${name}" must include a non-empty command array.`
    );
  }

  const params = parseRepoToolParams(rawTool.params);
  const scope = parseRepoToolScope(rawTool.scope);

  return { name, description, command, params, scope };
}

export function parseRepoHooks(config: RepoToolFile | null): RepoHooks {
  if (
    !config?.hooks ||
    typeof config.hooks !== "object" ||
    Array.isArray(config.hooks)
  )
    return {};

  const raw = config.hooks as Record<string, unknown>;
  return raw.stop ? { stop: parseHookDefinition(raw.stop, "stop") } : {};
}

function parseHookDefinition(value: unknown, name: string): RepoHookDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid hook definition for "${name}".`);
  }
  const raw = value as Record<string, unknown>;
  const command =
    Array.isArray(raw.command) &&
    raw.command.every((part) => typeof part === "string")
      ? raw.command.map((part) => (part as string).trim()).filter(Boolean)
      : [];

  if (command.length === 0) {
    throw new Error(`Hook "${name}" must include a non-empty command array.`);
  }

  const description =
    typeof raw.description === "string" ? raw.description.trim() : undefined;

  return { command, ...(description ? { description } : {}) };
}

const VALID_SCOPES = new Set<RepoToolScope>(["agent", "reviewer", "job"]);

function parseRepoToolScope(raw: unknown): RepoToolScope[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const scopes: RepoToolScope[] = [];
  for (const entry of raw) {
    if (typeof entry === "string" && VALID_SCOPES.has(entry as RepoToolScope)) {
      scopes.push(entry as RepoToolScope);
    }
  }
  return scopes.length > 0 ? scopes : undefined;
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
    const description =
      typeof p.description === "string" ? p.description.trim() : "";

    if (!name || !type || !flag) {
      throw new Error(
        `Param at index ${i} must have name, type (string|boolean), and flag.`
      );
    }
    return { name, type, flag, description };
  });
}
