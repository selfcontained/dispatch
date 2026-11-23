import { MessageCircleQuestion } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/tooltip";
import { useStreamFeedSelect } from "@/hooks/use-stream";
import { isOpenInput } from "@/hooks/use-inbox";
import { useJumpToTurn } from "@/hooks/use-block-jump";

/** A navigation shortcut in the existing header, including asks outside the loaded page. */
export function PendingInputsButton({
  agentId,
}: {
  agentId: string | null;
}): JSX.Element | null {
  const rootId = agentId;
  const { data: inputs = [] } = useStreamFeedSelect(
    rootId,
    (_entries, across) =>
      across.openInputs
        .filter(isOpenInput)
        .map((block) => ({ id: block.id, kind: block.kind })),
    false
  );
  const [lastId, setLastId] = useState<string | null>(null);
  const jump = useJumpToTurn();
  if (!agentId || inputs.length === 0) return null;
  const label = `${inputs.length} open ${inputs.length === 1 ? inputs[0]!.kind : "questions or forms"}. Jump to next`;
  return (
    <Hint label={label}>
      <Button
        type="button"
        variant="ghost"
        tone="primary"
        size="xs"
        className="shrink-0"
        aria-label={label}
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
        <MessageCircleQuestion aria-hidden="true" />
        <span>{inputs.length}</span>
        <span className="hidden md:inline">to answer</span>
      </Button>
    </Hint>
  );
}
