import type {
  AgentPermissionRequest,
  AgentPermissionsResponse,
} from "@dispatch/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, ShieldCheck } from "lucide-react";
import { useCallback, useId, useLayoutEffect, useRef, useState } from "react";

import {
  BlockBody,
  BlockFooter,
  BlockHeader,
  BlockShell,
} from "@/components/ui/block-shell";
import { Button, type ButtonProps } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { FieldError } from "@/components/ui/field";
import type { Agent } from "@/components/app/types";
import { fetchAgents } from "@/hooks/use-agent-tree";
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
      className="mb-3 max-h-[50vh] space-y-2 overflow-y-auto"
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

/**
 * Input a command line carries on its own. Anything else a tool sends with
 * one (an escalation, a sandbox switch) changes what is being approved, so
 * the request then opens with its details showing. A working directory is
 * routine only when it is the agent's own workspace.
 */
const ROUTINE_KEYS = new Set([
  "command",
  "cmd",
  "cwd",
  "workdir",
  "description",
  "timeout",
  "timeout_ms",
]);

type PermissionInput = {
  command?: string;
  cwd?: string;
  /** The command line is the whole of what is being approved. */
  routine: boolean;
};

/** Control and format characters can make a line read as another command. */
const INVISIBLE = /[\p{Cc}\p{Cf}\u2028\u2029]/u;

/** The command in a request's details, which lead with the tool's raw JSON input. */
function readPermissionInput(
  details: string,
  workspace: string | undefined
): PermissionInput {
  const json = /^\{\n[\s\S]*?\n\}/.exec(details)?.[0];
  if (!json) return { routine: false };
  try {
    const input = JSON.parse(json) as Record<string, unknown>;
    const raw = input.command ?? input.cmd;
    const command =
      typeof raw === "string"
        ? raw
        : Array.isArray(raw) && raw.every((part) => typeof part === "string")
          ? raw
              .map((part: string) =>
                /^[\w@%+=:,./-]+$/.test(part) ? part : JSON.stringify(part)
              )
              .join(" ")
          : undefined;
    const cwd = input.cwd ?? input.workdir;
    return {
      command,
      cwd: typeof cwd === "string" ? cwd : undefined,
      routine:
        !!command &&
        !INVISIBLE.test(command) &&
        // Two keys for one thing could say two things; one line shows one.
        !("command" in input && "cmd" in input) &&
        !("cwd" in input && "workdir" in input) &&
        // Where a command runs is part of what is approved.
        (cwd === undefined || cwd === workspace) &&
        details.trim() === json &&
        Object.keys(input).every((key) => ROUTINE_KEYS.has(key)),
    };
  } catch {
    return { routine: false };
  }
}

/**
 * The request as one code line, with the rest behind a disclosure. The
 * disclosure starts open whenever that line is not the whole request:
 * nobody approves what they were not shown.
 */
function RequestDetails({
  agentId,
  details,
}: {
  agentId: string;
  details: string;
}) {
  const selectWorkspace = useCallback(
    (agents: Agent[]) => {
      const agent = agents.find((item) => item.id === agentId);
      return agent?.workspacePath ?? agent?.worktreePath ?? agent?.cwd;
    },
    [agentId]
  );
  const { data: workspace } = useQuery({
    queryKey: ["agents"],
    queryFn: fetchAgents,
    select: selectWorkspace,
    staleTime: Infinity,
  });
  const { command, cwd, routine } = readPermissionInput(
    details,
    workspace ?? undefined
  );
  const lines = command?.trim().split("\n") ?? [];
  const mustShow = !routine || lines.length > 1;
  const [open, setOpen] = useState(mustShow);
  const line = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (mustShow) setOpen(true);
  }, [mustShow]);
  useLayoutEffect(() => {
    const element = line.current;
    if (!element) return;
    let overflowed = false;
    // Opens when the line stops fitting, and only then: closing the request
    // can itself change the width, which must not open it straight back up.
    const check = () => {
      const overflows = element.scrollWidth > element.clientWidth;
      if (overflows && !overflowed) setOpen(true);
      overflowed = overflows;
    };
    check();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(check);
    observer.observe(element);
    // The text's own width changes when a font loads, the box's does not.
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => observer.disconnect();
  }, []);
  const raw = (
    <pre className="whitespace-pre-wrap break-all font-mono">{details}</pre>
  );
  return (
    <>
      {command ? (
        <div className="mt-2 flex min-w-0 items-center gap-2 rounded-sm bg-muted px-2 py-1">
          <code
            ref={line}
            // Scrolls on its own, so the keyboard needs a way onto it.
            tabIndex={0}
            className="min-w-0 flex-1 overflow-x-auto whitespace-pre rounded-sm font-mono text-body-sm focus-ring-inset"
            data-testid="permission-command"
          >
            <span className="inline-block">{lines[0]}</span>
          </code>
          {lines.length > 1 ? (
            <span className="shrink-0 text-label-sm text-muted-foreground">
              +{lines.length - 1} {lines.length === 2 ? "line" : "lines"}
            </span>
          ) : null}
        </div>
      ) : null}
      <Collapsible open={open} onOpenChange={setOpen} className="mt-1">
        <CollapsibleTrigger asChild>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="group -ml-2"
          >
            <ChevronRight
              aria-hidden="true"
              className="transition-transform group-data-[state=open]:rotate-90"
            />
            Full request
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div
            tabIndex={0}
            role="group"
            aria-label="Full request"
            className="mt-1 max-h-32 space-y-2 overflow-auto rounded-sm bg-muted p-2 text-body-sm focus-ring-inset sm:max-h-48"
            data-testid="permission-details"
          >
            {command ? (
              <dl className="space-y-2">
                <div>
                  <dt className="text-label-sm text-muted-foreground">
                    Command
                  </dt>
                  <dd className="whitespace-pre-wrap break-all font-mono">
                    {command}
                  </dd>
                </div>
                {cwd ? (
                  <div>
                    <dt className="text-label-sm text-muted-foreground">
                      Working directory
                    </dt>
                    <dd className="break-all font-mono">{cwd}</dd>
                  </div>
                ) : null}
                <div>
                  <dt className="text-label-sm text-muted-foreground">
                    Raw input
                  </dt>
                  <dd>{raw}</dd>
                </div>
              </dl>
            ) : (
              raw
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </>
  );
}

/** The narrowest grant leads; a standing grant is never the primary action. */
function optionVariant(
  option: AgentPermissionRequest["options"][number],
  options: AgentPermissionRequest["options"]
): ButtonProps["variant"] {
  if (option.kind.startsWith("reject")) return "secondary";
  return option === options.find((item) => item.kind === "allow_once")
    ? "primary"
    : "secondary";
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
  const scopeId = useId();
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
    <BlockShell level="ask" state="waiting" data-testid="permission-request">
      <BlockHeader className="text-heading-sm">
        <ShieldCheck
          aria-hidden="true"
          className="size-icon-lg shrink-0 text-warning"
        />
        Approval needed
      </BlockHeader>
      <BlockBody className="mt-1">
        <p className="break-words text-body-md">{request.title}</p>
        {request.details ? (
          <RequestDetails agentId={agentId} details={request.details} />
        ) : null}
      </BlockBody>
      <BlockFooter className="flex-col items-stretch sm:max-w-sm">
        {request.options.map((option) => (
          <div
            key={option.optionId}
            className="flex w-full min-w-0 max-w-full flex-col gap-1"
          >
            <Button
              type="button"
              size="xs"
              variant={optionVariant(option, request.options)}
              aria-describedby={
                option.kind === "allow_always"
                  ? `${scopeId}-${option.optionId}`
                  : undefined
              }
              wrap
              className="w-full max-w-full break-words"
              disabled={!connected || answer.isPending}
              onClick={() => answer.mutate(option.optionId)}
            >
              {option.kind === "allow_always" ? "Always allow" : option.name}
            </Button>
            {option.kind === "allow_always" ? (
              <p
                id={`${scopeId}-${option.optionId}`}
                className="mb-2 break-words text-center text-body-sm text-muted-foreground"
              >
                {option.name}
              </p>
            ) : null}
          </div>
        ))}
        {!request.options.some((option) => option.kind.startsWith("reject")) ? (
          <Button
            type="button"
            size="xs"
            variant="secondary"
            wrap
            className="w-full max-w-full break-words"
            disabled={!connected || answer.isPending}
            onClick={() => answer.mutate(null)}
          >
            Deny
          </Button>
        ) : null}
      </BlockFooter>
      {!connected ? (
        <p role="status" className="mt-2 text-body-sm text-muted-foreground">
          Reconnecting to the agent. No permission has been granted.
        </p>
      ) : null}
      {answer.error ? (
        <FieldError className="mt-2">{answer.error.message}</FieldError>
      ) : null}
    </BlockShell>
  );
}
