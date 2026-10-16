import { useMutation } from "@tanstack/react-query";
import { ChevronDown, Plug, X } from "lucide-react";
import { useId, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useAgentCommandData } from "@/hooks/use-agent-commands";

/** Uses the agent's ordinary chat delivery, keeping results and approvals there. */
export function AgentMcpDialog({
  agentId,
  active,
  disabledReason,
  onSend,
}: {
  agentId: string;
  active: boolean;
  disabledReason: string | null;
  onSend: (
    text: string,
    attachments: [],
    options: { delivery: "queue" }
  ) => Promise<void>;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [troubleshooting, setTroubleshooting] = useState(false);
  const troubleshootingId = useId();
  const query = useAgentCommandData(agentId, active);
  const send = useMutation({
    mutationFn: (command: "/mcp" | "/mcp reconnect") =>
      onSend(command, [], { delivery: "queue" }),
    onSuccess: () => setOpen(false),
  });
  const data = query.data;
  const provider = data?.mcp?.provider;
  const unavailable = query.isPending
    ? "Checking available commands…"
    : query.isError
      ? "Could not check this agent’s commands. Try refreshing."
      : data?.connected === false
        ? "This agent has no connected session. Start or reconnect the agent to check its MCP servers."
        : !data?.mcp?.available
          ? "MCP diagnostics are not supported by this agent’s current session."
          : disabledReason;
  const canSend = !unavailable && !!data?.mcp?.available && !send.isPending;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          send.reset();
          setTroubleshooting(false);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-1.5 text-[11px] text-muted-foreground pointer-coarse:min-h-11"
          aria-label="MCP servers"
        >
          <Plug className="h-3 w-3" />
          MCP
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center justify-between gap-2">
            <DialogTitle>MCP servers</DialogTitle>
            <DialogClose asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Close MCP servers"
              >
                <X className="h-4 w-4" />
              </Button>
            </DialogClose>
          </div>
          <DialogDescription>
            Check MCP connections or retry failed servers. Results appear in
            chat.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 space-y-3 overflow-y-auto text-sm">
          {unavailable ? <p role="status">{unavailable}</p> : null}
          {data?.mcp?.available ? (
            <>
              <p className="text-muted-foreground">
                {provider === "codex"
                  ? "Reconnect reloads MCP configuration for all sessions in Codex’s process and retries failed, stopped, or changed servers. It may require sign-in."
                  : "Reconnect retries disconnected servers, leaves disabled servers alone, and may require sign-in."}
              </p>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="gap-1 px-0"
                aria-expanded={troubleshooting}
                aria-controls={troubleshootingId}
                onClick={() => setTroubleshooting((value) => !value)}
              >
                <ChevronDown
                  className={`h-3 w-3 transition-transform ${troubleshooting ? "rotate-180" : ""}`}
                />
                Troubleshooting
              </Button>
              <div
                id={troubleshootingId}
                hidden={!troubleshooting}
                className="space-y-3 text-xs text-muted-foreground"
              >
                {provider === "codex" ? (
                  <p>
                    If Codex configuration already defines a server with the
                    same name, it may replace the server supplied by Dispatch,
                    even when disabled. Check the startup report in chat and
                    your Codex configuration. Effective settings are not
                    available here. Unchanged connected servers keep their
                    connections.
                  </p>
                ) : null}
                <p>
                  Status includes failures and sign-in needs. If sign-in is
                  unavailable here, authenticate with the provider on this
                  machine, then retry.
                </p>
                <p>
                  Commands wait for the current turn. A connected agent does not
                  mean its MCP servers are connected. These actions do not edit
                  configuration or change tool permissions.
                </p>
              </div>
            </>
          ) : null}
          {send.isError ? (
            <p role="alert" className="text-destructive">
              Could not send the command. Refresh availability and try again.
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button
            type="button"
            variant="default"
            disabled={query.isFetching || send.isPending}
            onClick={() => void query.refetch()}
          >
            Refresh availability
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={!canSend}
            onClick={() => send.mutate("/mcp")}
          >
            Request status
          </Button>
          <Button
            type="button"
            variant="default"
            disabled={!canSend}
            onClick={() => send.mutate("/mcp reconnect")}
          >
            Reconnect servers
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
