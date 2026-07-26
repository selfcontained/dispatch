import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, ChevronRight } from "lucide-react";

import { AgentTypeIcon } from "@/components/app/agent-type-icon";
import {
  MessageBubble,
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
    <div className="border-b border-border last:border-b-0">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-3 text-left text-sm font-semibold text-muted-foreground hover:bg-muted/40 transition-colors"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0" />
        )}
        <AgentTypeIcon type={thread.otherType} className="shrink-0" />
        <span className="truncate">{thread.otherName}</span>
        <span className="ml-auto shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
          {thread.messages.length}
        </span>
      </button>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.35, ease: "easeInOut" }}
            className="overflow-hidden"
          >
            <div className="flex flex-col gap-2 px-3 pb-3">
              {thread.messages.map((m) => (
                <MessageBubble
                  key={m.id}
                  message={m}
                  isSent={m.senderAgentId === agentId}
                />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
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
