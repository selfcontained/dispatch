import { useMutation } from "@tanstack/react-query";
import { Square } from "lucide-react";

import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

/**
 * Cancels the agent's running turn. The turn settles through the stream,
 * which is what hides this button again; the request only asks for it.
 */
export function StopTurnButton({
  agentId,
  onError,
}: {
  agentId: string;
  onError: (message: string) => void;
}): JSX.Element {
  const cancel = useMutation<unknown, Error>({
    mutationFn: () =>
      api(`/api/v1/agents/${encodeURIComponent(agentId)}/runtime/cancel`, {
        method: "POST",
      }),
    onError: (err) => onError(`Couldn't stop the turn: ${err.message}`),
  });
  return (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      // The stop control other agent UIs use: a filled disc with a small
      // square in it, in the text color rather than a status color.
      className="group m-2 h-7 w-7 shrink-0 rounded-full pointer-coarse:m-0 pointer-coarse:h-11 pointer-coarse:min-h-11 pointer-coarse:w-11 pointer-coarse:min-w-11"
      onClick={() => cancel.mutate()}
      disabled={cancel.isPending}
      data-testid="chat-stop-turn"
      title={cancel.isPending ? "Stopping…" : "Stop the running turn"}
      aria-label="Stop the running turn"
    >
      <span
        className="flex h-7 w-7 items-center justify-center rounded-full bg-foreground text-background group-hover:bg-foreground/85"
        aria-hidden="true"
      >
        <Square className="h-2.5 w-2.5 fill-current" strokeWidth={0} />
      </span>
    </Button>
  );
}
