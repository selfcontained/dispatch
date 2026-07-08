import { type AgentMessage } from "@/hooks/use-agent-messages";
import { cn } from "@/lib/utils";

export function MessageTimeline({
  messages,
}: {
  messages: AgentMessage[];
}): JSX.Element {
  return (
    <div className="flex flex-col divide-y divide-border rounded-md border border-border">
      {messages.map((m) => (
        <div
          key={m.id}
          className="px-3 py-2 text-xs"
          data-testid="history-message"
        >
          <div className="mb-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <span className="font-medium text-foreground">{m.senderName}</span>
            <span>→</span>
            <span className="font-medium text-foreground">
              {m.recipientName}
            </span>
            <span>·</span>
            <span>{new Date(m.createdAt).toLocaleTimeString()}</span>
            {!m.delivered && (
              <span className={cn("text-destructive")}>· not delivered</span>
            )}
          </div>
          <div className="whitespace-pre-wrap break-words text-foreground">
            {m.content}
          </div>
        </div>
      ))}
    </div>
  );
}
