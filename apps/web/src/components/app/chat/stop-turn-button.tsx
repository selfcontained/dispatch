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
      className="m-2 h-7 w-7 shrink-0 rounded-full text-status-waiting hover:text-status-waiting pointer-coarse:m-0 pointer-coarse:h-11 pointer-coarse:min-h-11 pointer-coarse:w-11 pointer-coarse:min-w-11"
      onClick={() => cancel.mutate()}
      disabled={cancel.isPending}
      data-testid="chat-stop-turn"
      title={cancel.isPending ? "Stopping…" : "Stop the running turn"}
      aria-label="Stop the running turn"
    >
      <Square className="h-3.5 w-3.5 fill-current" aria-hidden="true" />
    </Button>
  );
}
