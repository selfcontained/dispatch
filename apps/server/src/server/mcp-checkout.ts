import { remotePlacement } from "@dispatch/runner-protocol";
import type { AgentManager, AgentRecord } from "../agents/manager.js";
import {
  parseRepoToolFile,
  parseRepoTools,
  REPO_TOOL_MANIFEST_PATH,
} from "../shared/mcp/repo-tools.js";

export async function readAgentCheckoutFile(
  manager: AgentManager,
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
  return { checkoutRoot: null, repositoryRoot: null };
}

export async function discoverRepoTools(
  manager: AgentManager,
  agent: AgentRecord
) {
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
  const remote = remotePlacement(agent.cwd);
  return parseRepoTools(
    parseRepoToolFile(content),
    remote
      ? async () => {
          throw new Error(
            "Checkout manifest commands are unavailable on enrolled runners."
          );
        }
      : undefined
  );
}
