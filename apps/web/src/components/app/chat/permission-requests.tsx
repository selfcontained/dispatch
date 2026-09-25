import type {
  AgentPermissionRequest,
  AgentPermissionsResponse,
} from "@dispatch/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

/** The host owns pending requests; polling also recovers from reloads and server reconnects. */
export function PermissionRequests({
  agentId,
  active,
}: {
  agentId: string;
  active: boolean;
}) {
  const key = ["agent-permissions", agentId];
  const url = `/api/v1/agents/${encodeURIComponent(agentId)}/permissions`;
  const query = useQuery<AgentPermissionsResponse>({
    queryKey: key,
    queryFn: () => api(url),
    enabled: active,
    refetchInterval: active ? 2000 : false,
  });
  const requests = query.data?.requests ?? [];
  if (!active || !requests.length) return null;
  return (
    <section
      aria-label="Permission requests"
      className="mb-3 max-h-[40vh] space-y-2 overflow-y-auto"
      data-testid="permission-requests"
    >
      {requests.map((request) => (
        <PermissionRequest
          key={request.id}
          request={request}
          agentId={agentId}
          connected={query.data?.connected === true && !query.isError}
        />
      ))}
    </section>
  );
}

function PermissionRequest({
  request,
  agentId,
  connected,
}: {
  request: AgentPermissionRequest;
  agentId: string;
  connected: boolean;
}) {
  const client = useQueryClient();
  const key = ["agent-permissions", agentId];
  const answer = useMutation<AgentPermissionsResponse, Error, string | null>({
    mutationFn: (optionId) =>
      api(
        `/api/v1/agents/${encodeURIComponent(agentId)}/permissions/${encodeURIComponent(request.id)}`,
        {
          method: "POST",
          body: JSON.stringify({ optionId }),
        }
      ),
    onSuccess: (data) => client.setQueryData(key, data),
    onSettled: () => client.invalidateQueries({ queryKey: key }),
  });
  return (
    <div className="rounded-md border border-status-waiting/40 bg-status-waiting/5 p-3">
      <div className="mb-1 flex items-center gap-2 text-sm font-medium">
        <ShieldCheck className="h-4 w-4 shrink-0 text-status-waiting" />
        Approval needed
      </div>
      <p className="break-words text-sm">{request.title}</p>
      {request.details ? (
        <pre className="my-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/50 p-2 text-xs">
          {request.details}
        </pre>
      ) : null}
      <div className="mt-2 flex flex-col items-start">
        {request.options.map((option) => (
          <Button
            key={option.optionId}
            size="sm"
            variant="ghost"
            className={`h-auto min-h-8 max-w-full justify-start whitespace-normal break-words px-0 py-1.5 text-left font-normal underline-offset-4 hover:bg-transparent hover:underline pointer-coarse:min-h-11 ${option.kind.startsWith("reject") ? "text-muted-foreground" : "text-primary hover:text-primary"}`}
            disabled={!connected || answer.isPending}
            onClick={() => answer.mutate(option.optionId)}
          >
            {option.name}
          </Button>
        ))}
        {!request.options.some((option) => option.kind.startsWith("reject")) ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-auto min-h-8 justify-start px-0 py-1.5 text-left font-normal underline-offset-4 hover:bg-transparent hover:underline pointer-coarse:min-h-11"
            disabled={!connected || answer.isPending}
            onClick={() => answer.mutate(null)}
          >
            Deny
          </Button>
        ) : null}
      </div>
      {!connected ? (
        <p role="status" className="mt-2 text-xs text-muted-foreground">
          Reconnecting to the agent. No permission has been granted.
        </p>
      ) : null}
      {answer.error ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {answer.error.message}
        </p>
      ) : null}
    </div>
  );
}
