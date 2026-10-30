import { MessageCircleQuestion } from "lucide-react";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAgentChatUnread } from "@/hooks/use-chat-unread-summary";

/** Pending input stays visible even after the user reads the agent's stream. */
export function ChatUnreadBadge({
  agentId,
}: {
  agentId: string;
}): JSX.Element | null {
  const { pendingQuestions } = useAgentChatUnread(agentId);
  if (pendingQuestions <= 0) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          tabIndex={0}
          aria-label="Needs your input"
          data-testid="agent-chat-unread"
          className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center text-status-waiting outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <MessageCircleQuestion className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
      </TooltipTrigger>
      <TooltipContent>Needs your input</TooltipContent>
    </Tooltip>
  );
}
