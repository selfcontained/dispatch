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
      size="sm"
      variant="default"
      className="h-6 shrink-0 gap-1 px-2 text-xs"
      onClick={() => cancel.mutate()}
      disabled={cancel.isPending}
      data-testid="chat-stop-turn"
      aria-label="Stop the running turn"
    >
      <Square className="h-3 w-3 fill-current" aria-hidden="true" />
      {cancel.isPending ? "Stopping…" : "Stop"}
    </Button>
  );
}
