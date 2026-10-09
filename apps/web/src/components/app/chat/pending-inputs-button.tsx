import { MessageCircleQuestion } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useRootAgentId, useDescendantAgentIds } from "@/hooks/use-agent-tree";
import { useStreamFeedSelect } from "@/hooks/use-stream";
import { isOpenInput } from "@/hooks/use-inbox";
import { useJumpToTurn } from "@/hooks/use-block-jump";

/** A navigation shortcut in the existing header, including asks outside the loaded page. */
export function PendingInputsButton({
  agentId,
  showChildAgents = true,
}: {
  agentId: string | null;
  showChildAgents?: boolean;
}): JSX.Element | null {
  const rootId = useRootAgentId(agentId);
  const descendants = useDescendantAgentIds(agentId);
  const { data: inputs = [] } = useStreamFeedSelect(
    rootId,
    (_entries, across) =>
      across.openInputs
        .filter(isOpenInput)
        .filter(
          (block) =>
            agentId === rootId ||
            (block.author.kind === "agent" &&
              (block.author.agentId === agentId ||
                (showChildAgents && descendants.has(block.author.agentId))))
        )
        .map((block) => ({ id: block.id, kind: block.kind }))
  );
  const [lastId, setLastId] = useState<string | null>(null);
  const jump = useJumpToTurn();
  if (!agentId || inputs.length === 0) return null;
  const label = `${inputs.length} open ${inputs.length === 1 ? inputs[0]!.kind : "questions or forms"}. Jump to next`;
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-8 text-primary shrink-0 gap-1 px-2 text-xs max-sm:min-h-11 [@media(pointer:coarse)]:min-h-11"
      aria-label={label}
      title={label}
      data-testid="chat-pending-inputs"
      onClick={() => {
        const next =
          inputs[
            (inputs.findIndex((input) => input.id === lastId) + 1) %
              inputs.length
          ]!;
        setLastId(next.id);
        jump(agentId, { blockId: next.id, threadId: null }, "smooth");
      }}
    >
      <MessageCircleQuestion className="h-3.5 w-3.5" />
      <span>{inputs.length}</span>
      <span className="hidden md:inline">to answer</span>
    </Button>
  );
}
