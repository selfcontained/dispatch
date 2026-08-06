import { useMemo, useState } from "react";

import {
  MessageThreadAccordion,
  groupByParticipant,
  type Thread,
} from "@/components/app/messages-panel";
import { type AgentMessage } from "@/hooks/use-agent-messages";

function HistoryThreadGroup({
  thread,
  agentId,
}: {
  thread: Thread;
  agentId: string;
}): JSX.Element {
  const [expanded, setExpanded] = useState(true);

  return (
    <MessageThreadAccordion
      thread={thread}
      agentId={agentId}
      expanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
      className="last:border-b-0"
    />
  );
}

export function HistoryMessages({
  messages,
  agentId,
}: {
  messages: AgentMessage[];
  agentId: string;
}): JSX.Element {
  const threads = useMemo(
    () => groupByParticipant(messages, agentId),
    [messages, agentId]
  );

  return (
    <div className="rounded-md border border-border">
      {threads.map((thread) => (
        <HistoryThreadGroup
          key={thread.otherId}
          thread={thread}
          agentId={agentId}
        />
      ))}
    </div>
  );
}
