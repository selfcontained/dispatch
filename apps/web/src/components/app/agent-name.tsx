import { useAgentName } from "@/hooks/use-agent-tree";

export function AgentName({ agentId }: { agentId: string }): JSX.Element {
  return <>{useAgentName(agentId)}</>;
}
