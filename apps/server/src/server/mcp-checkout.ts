import { RunnerCapabilityUnavailable } from "../agents/remote/service.js";
import type { AgentManager, AgentRecord } from "../agents/manager.js";
import {
  parseRepoToolFile,
  parseRepoTools,
  REPO_TOOL_MANIFEST_PATH,
} from "../shared/mcp/repo-tools.js";

export async function readAgentCheckoutFile(
  manager: Pick<AgentManager, "inspectCheckout">,
  agent: AgentRecord,
  path: string
) {
  const reply = await manager.inspectCheckout(agent, {
    kind: "readFile",
    path,
  });
  if (reply.kind !== "readFile")
    throw new Error("Runner did not return the checkout file.");
  return reply.content;
}

export async function mcpCheckoutRoots(
  manager: AgentManager,
  agent: AgentRecord
) {
  try {
    const reply = await manager.inspectCheckout(agent, { kind: "roots" });
    if (reply.kind === "roots") return reply;
  } catch {
    // Built-in MCP tools remain usable when the checkout is unavailable.
  }
  return null;
}

/**
 * The session's repo tools, on the same rule for every runner: the guarded
 * manifest read, then commands against that read. A runner too old for
 * checkout commands keeps its tool list (read as a plain file) and reports
 * its capability error when a tool is called.
 */
export async function discoverRepoTools(
  manager: Pick<
    AgentManager,
    "inspectCheckout" | "readRepoManifest" | "runRepoCommand"
  >,
  agent: AgentRecord
) {
  let file;
  try {
    file = await manager.readRepoManifest(agent);
  } catch (error) {
    if (!(error instanceof RunnerCapabilityUnavailable)) return [];
    let content: string | null;
    try {
      content = await readAgentCheckoutFile(
        manager,
        agent,
        REPO_TOOL_MANIFEST_PATH
      );
    } catch {
      return [];
    }
    return parseRepoTools(parseRepoToolFile(content), async () => {
      throw new Error(`Repository tool unavailable. ${error.message}`);
    });
  }
  if (!file) return [];
  return parseRepoTools(
    parseRepoToolFile(file.content),
    (argv, _cwd, _id, signal) =>
      manager.runRepoCommand(agent, file.state, argv, signal)
  );
}
