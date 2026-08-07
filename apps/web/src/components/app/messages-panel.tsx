import { useMemo, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAtom } from "jotai";
import { AnimatePresence, motion } from "framer-motion";
import {
  MessageSquare,
  ArrowUpRight,
  ArrowDownLeft,
  ChevronDown,
  ChevronRight,
  Copy,
  Check,
} from "lucide-react";

import { AgentTypeIcon } from "@/components/app/agent-type-icon";
import type { Agent } from "@/components/app/types";
import {
  useAgentMessages,
  type AgentMessage,
} from "@/hooks/use-agent-messages";
import { useCopyText } from "@/hooks/use-copy";
import { api } from "@/lib/api";
import { formatRelativeTime } from "@/lib/format";
import { messageGroupsCollapsedAtomFamily } from "@/lib/store";
import { cn } from "@/lib/utils";

export type Thread = {
  otherId: string;
  otherName: string;
  otherType?: string;
  messages: AgentMessage[];
};

export function groupByParticipant(
  messages: AgentMessage[],
  agentId: string,
  agentMap?: Map<string, Agent>
): Thread[] {
  const threads = new Map<string, Thread>();
  for (const m of messages) {
    const isSent = m.senderAgentId === agentId;
    const otherId = isSent ? m.recipientAgentId : m.senderAgentId;
    const otherName = isSent ? m.recipientName : m.senderName;
    const existing = threads.get(otherId);
    if (existing) {
      existing.messages.push(m);
    } else {
      const otherAgent = agentMap?.get(otherId);
      threads.set(otherId, {
        otherId,
        otherName,
        otherType: otherAgent?.type ?? undefined,
        messages: [m],
      });
    }
  }
  return Array.from(threads.values());
}

export function MessageBubble({
  message,
  isSent,
}: {
  message: AgentMessage;
  isSent: boolean;
}): JSX.Element {
  const [copied, copyText] = useCopyText();

  return (
    <div className={cn("flex", isSent ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[85%] rounded-xl px-3 py-2 text-xs",
          isSent
            ? "rounded-br-sm bg-primary text-primary-foreground"
            : "rounded-bl-sm bg-muted text-foreground",
          message.readAt === null && !isSent && "ring-1 ring-primary/40"
        )}
        data-testid="message-item"
      >
        <div className="whitespace-pre-wrap break-words">{message.content}</div>
        <div
          className={cn(
            "mt-1 flex items-center gap-1.5 text-[10px]",
            isSent ? "text-primary-foreground/60" : "text-muted-foreground"
          )}
        >
          {isSent ? (
            <ArrowUpRight className="h-2.5 w-2.5" />
          ) : (
            <ArrowDownLeft className="h-2.5 w-2.5" />
          )}
          <span>{formatRelativeTime(message.createdAt)}</span>
          {!message.delivered && (
            <span
              className={cn(
                isSent ? "text-destructive-foreground" : "text-destructive"
              )}
              title="The recipient agent wasn't running, so it never received this message."
            >
              · not delivered
            </span>
          )}
          <button
            type="button"
            onClick={() => copyText(message.content)}
            className={cn(
              "ml-auto -mr-1 flex h-6 w-6 items-center justify-center rounded transition-colors",
              isSent
                ? "text-primary-foreground/40 hover:text-primary-foreground/80"
                : "text-muted-foreground hover:text-foreground"
            )}
            title="Copy to clipboard"
            aria-label="Copy message"
          >
            {copied ? (
              <Check className="h-2.5 w-2.5 text-emerald-400" />
            ) : (
              <Copy className="h-2.5 w-2.5" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

export function MessageThreadAccordion({
  thread,
  agentId,
  expanded,
  onToggle,
  className,
}: {
  thread: Thread;
  agentId: string;
  expanded: boolean;
  onToggle: () => void;
  className?: string;
}): JSX.Element {
  return (
    <div className={cn("border-b border-border", className)}>
      <button
        type="button"
        onClick={onToggle}
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

export function MessagesPanel({
  agentId,
}: {
  agentId: string | null;
}): JSX.Element {
  const { messages, isLoading } = useAgentMessages(agentId);
  const [collapsedIds, setCollapsedIds] = useAtom(
    messageGroupsCollapsedAtomFamily(agentId ?? "")
  );

  const { data: agentMap } = useQuery<Agent[], Error, Map<string, Agent>>({
    queryKey: ["agents"],
    queryFn: async () => {
      const result = await api<{ agents: Agent[] }>("/api/v1/agents");
      return result.agents;
    },
    select: (agents) => new Map(agents.map((a) => [a.id, a])),
  });

  const threads = useMemo(
    () => (agentId ? groupByParticipant(messages, agentId, agentMap) : []),
    [messages, agentId, agentMap]
  );

  const collapsedSet = useMemo(() => new Set(collapsedIds), [collapsedIds]);

  const toggleThread = useCallback(
    (otherId: string) => {
      setCollapsedIds((prev) =>
        prev.includes(otherId)
          ? prev.filter((id) => id !== otherId)
          : [...prev, otherId]
      );
    },
    [setCollapsedIds]
  );

  if (!agentId) {
    return (
      <div className="grid h-full place-items-center p-4 text-center text-sm text-muted-foreground">
        <div className="flex flex-col items-center gap-2">
          <MessageSquare className="h-8 w-8 text-muted-foreground" />
          <div className="mt-4">No agent selected.</div>
        </div>
      </div>
    );
  }

  if (isLoading && messages.length === 0) {
    return (
      <div className="grid h-full place-items-center p-4">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className="grid h-full place-items-center p-4 text-center text-sm text-muted-foreground">
        <div className="flex flex-col items-center gap-2">
          <MessageSquare className="h-8 w-8 text-muted-foreground" />
          <div className="mt-4">This agent has no messages yet.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {threads.map((thread) => (
        <MessageThreadAccordion
          key={thread.otherId}
          thread={thread}
          agentId={agentId}
          expanded={!collapsedSet.has(thread.otherId)}
          onToggle={() => toggleThread(thread.otherId)}
        />
      ))}
    </div>
  );
}
