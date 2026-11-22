import { remotePlacement } from "@dispatch/runner-protocol";
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

export async function discoverRepoTools(
  manager: Pick<
    AgentManager,
    "inspectCheckout" | "readRepoManifest" | "runRepoCommand"
  >,
  agent: AgentRecord,
  allowRemoteCommands: boolean
) {
  const remote = remotePlacement(agent.cwd);
  let unavailable: RunnerCapabilityUnavailable | undefined;
  if (!remote || allowRemoteCommands) {
    let file;
    try {
      file = await manager.readRepoManifest(agent);
    } catch (error) {
      if (!remote || !(error instanceof RunnerCapabilityUnavailable)) return [];
      // Keep discovery on older peers and surface their capability error on call.
      unavailable = error;
    }
    if (file) {
      return parseRepoTools(
        parseRepoToolFile(file.content),
        (argv, _cwd, _id, signal) =>
          manager.runRepoCommand(agent, file.state, argv, signal)
      );
    }
    if (!unavailable) return [];
  }

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
    const reason =
      unavailable?.message ??
      "Remote execution requires the selected session’s MCP credential or a credential for its active job run.";
    throw new Error(`Repository tool unavailable. ${reason}`);
  });
}
