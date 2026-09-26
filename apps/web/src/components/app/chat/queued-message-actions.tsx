import { Trash2 } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { streamFeedQueryKey } from "@/hooks/use-stream";
import { api } from "@/lib/api";

export function QueuedMessageActions({
  agentId,
  messageId,
  canSendNow = true,
}: {
  agentId: string;
  messageId: string;
  canSendNow?: boolean;
}) {
  const client = useQueryClient();
  const action = useMutation({
    mutationFn: (kind: "delete" | "send-now") =>
      api<void>(
        `/api/v1/streams/${encodeURIComponent(agentId)}/blocks/${encodeURIComponent(messageId)}${kind === "send-now" ? "/send-now" : ""}`,
        { method: kind === "delete" ? "DELETE" : "POST" }
      ),
    onSettled: () =>
      client.invalidateQueries({ queryKey: streamFeedQueryKey(agentId) }),
  });
  return (
    <>
      <div className="flex shrink-0 items-center gap-1.5">
        {canSendNow ? (
          <Button
            variant="ghost-warning"
            size="sm"
            className="h-6 border border-transparent px-2 text-[11px] hover:border-status-waiting/40 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
            disabled={action.isPending || action.isSuccess}
            title="Deliver during the current turn when supported"
            onClick={() => action.mutate("send-now")}
          >
            Send now
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 border border-transparent p-0 hover:border-destructive/40 hover:bg-destructive/15 hover:text-destructive [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
          aria-label="Delete"
          disabled={action.isPending || action.isSuccess}
          title="Delete this queued message so it will not be delivered"
          onClick={() => action.mutate("delete")}
        >
          <Trash2 className="h-3 w-3" aria-hidden="true" />
        </Button>
      </div>
      {action.isError ? (
        <span role="alert" className="col-span-2 text-xs text-destructive">
          {action.error.message}
        </span>
      ) : null}
    </>
  );
}
