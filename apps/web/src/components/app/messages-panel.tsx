import { useMemo } from "react";
import { MessageSquare, ArrowUpRight, ArrowDownLeft } from "lucide-react";

import {
  useAgentMessages,
  type AgentMessage,
} from "@/hooks/use-agent-messages";
import { cn } from "@/lib/utils";

type Thread = {
  otherId: string;
  otherName: string;
  messages: AgentMessage[];
};

function groupByParticipant(
  messages: AgentMessage[],
  agentId: string
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
      threads.set(otherId, { otherId, otherName, messages: [m] });
    }
  }
  return Array.from(threads.values());
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

export function MessagesPanel({
  agentId,
}: {
  agentId: string | null;
}): JSX.Element {
  const { messages, isLoading } = useAgentMessages(agentId);

  const threads = useMemo(
    () => (agentId ? groupByParticipant(messages, agentId) : []),
    [messages, agentId]
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
        <div key={thread.otherId} className="border-b border-border">
          <div className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {thread.otherName}
          </div>
          <div className="flex flex-col gap-1 px-3 pb-3">
            {thread.messages.map((m) => {
              const isSent = m.senderAgentId === agentId;
              return (
                <div
                  key={m.id}
                  className={cn(
                    "rounded-md border border-border bg-muted/20 px-2.5 py-1.5 text-xs",
                    m.readAt === null && !isSent && "border-primary/40"
                  )}
                  data-testid="message-item"
                >
                  <div className="mb-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                    {isSent ? (
                      <ArrowUpRight className="h-3 w-3" />
                    ) : (
                      <ArrowDownLeft className="h-3 w-3" />
                    )}
                    <span>{isSent ? "Sent" : "Received"}</span>
                    <span>·</span>
                    <span>{relativeTime(m.createdAt)}</span>
                    {!m.delivered && (
                      <span
                        className="text-destructive"
                        title="The recipient agent wasn't running, so it never received this message."
                      >
                        · not delivered
                      </span>
                    )}
                  </div>
                  <div className="whitespace-pre-wrap break-words text-foreground">
                    {m.content}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
