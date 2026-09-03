import { MessageCircleQuestion, MessageSquare } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { useAgentChatUnread } from "@/hooks/use-chat-unread-summary";
import { cn } from "@/lib/utils";

/**
 * Sidebar signal that an agent has chat replies the user has not read. An
 * open question takes the waiting accent so it reads as "needs you", not
 * just "new". Renders nothing with the flag off or nothing unread.
 */
export function ChatUnreadBadge({
  agentId,
  className,
}: {
  agentId: string;
  className?: string;
}): JSX.Element | null {
  const { unread, pendingQuestions } = useAgentChatUnread(agentId);
  if (unread <= 0 && pendingQuestions <= 0) return null;

  const asksSomething = pendingQuestions > 0;
  const count = Math.max(unread, pendingQuestions);
  const parts: string[] = [];
  if (unread > 0) {
    parts.push(`${unread} unread chat ${unread === 1 ? "reply" : "replies"}`);
  }
  if (asksSomething) {
    parts.push(
      `${pendingQuestions} open ${pendingQuestions === 1 ? "question" : "questions"}`
    );
  }
  const title = parts.join(" · ");

  return (
    <Badge
      className={cn(
        asksSomething
          ? "border-status-waiting/45 bg-status-waiting/15 text-status-waiting"
          : "border-primary/40 bg-primary/15 text-primary",
        className
      )}
      title={title}
      aria-label={title}
      data-testid="agent-chat-unread"
      data-pending-questions={pendingQuestions}
    >
      {asksSomething ? (
        <MessageCircleQuestion className="mr-1 h-3 w-3" />
      ) : (
        <MessageSquare className="mr-1 h-3 w-3" />
      )}
      {count > 99 ? "99+" : count}
    </Badge>
  );
}
