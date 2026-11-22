import { Markdown } from "@/components/ui/markdown";
import type { ReactNode } from "react";
import type { SystemEvent } from "@dispatch/shared";
import {
  ChevronDown,
  Info,
  ShieldCheck,
  GitPullRequest,
  ListChecks,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { MERGE_RISK } from "@/lib/merge-risk-presentation";
import {
  parseCheckNotice,
  PullRequestCheckResults,
} from "./pull-request-check-results";

/** Shared compact presentation for trusted observations and staged design examples. */
export interface SystemEventPresentation extends Omit<SystemEvent, "version"> {
  resource?: { label: string; url: string };
  details: string;
  defaultOpen?: boolean;
  at?: string;
}

export function SystemEventEntry({
  event,
  children,
  visibleContent,
  icon,
}: {
  event: SystemEventPresentation;
  children?: ReactNode;
  visibleContent?: ReactNode;
  /** Replaces the category glyph for events with an established icon. */
  icon?: ReactNode;
}) {
  const Icon = {
    risk: ShieldCheck,
    checks: ListChecks,
    lifecycle: GitPullRequest,
    info: Info,
  }[event.category];
  // Check observations show their results inline: no disclosure, one meta row.
  const inline = event.category === "checks";
  const notice = inline ? parseCheckNotice(event.details) : undefined;
  const parsedStatus = notice?.status;
  const status =
    event.status ??
    (["Passing", "Failing", "Pending", "Mixed"].includes(parsedStatus ?? "")
      ? (parsedStatus as SystemEventPresentation["status"])
      : undefined);
  const time = (
    <time
      className={
        inline ? undefined : "mt-1 block text-label-sm text-muted-foreground"
      }
      dateTime={event.at ?? "2026-11-10T10:42:00-07:00"}
    >
      {event.at
        ? new Date(event.at).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })
        : "10:42"}
    </time>
  );
  const commit = event.head && (
    <code title={event.head}>{event.head.slice(0, 7)}</code>
  );
  const resource = event.resource && (
    <div className="mt-3 font-sans text-body-md leading-snug">
      <a
        href={event.resource.url}
        target="_blank"
        rel="noreferrer"
        className="min-w-0 break-words text-foreground underline decoration-border underline-offset-4 focus-ring"
      >
        {event.resource.label}
      </a>
    </div>
  );
  const iconColor =
    event.risk === "human_review"
      ? "text-danger"
      : status === "Failing"
        ? "text-danger"
        : event.risk === "routine" || status === "Passing"
          ? "text-success"
          : status === "Pending" || event.risk === "abstain"
            ? "text-warning"
            : event.category === "lifecycle"
              ? "text-info"
              : "text-primary";
  // Check cards lead with the PR itself ("PR #1439 Title"), not a generic label.
  const prNumber = inline
    ? (event.resource?.url.match(/\/pull\/(\d+)(?:[/?#]|$)/)?.[1] ??
      notice?.pr?.number)
    : undefined;
  const prUrl = event.resource?.url ?? notice?.pr?.url;
  // Drop a leading "PR #n" from the title (shown as the number) and the
  // feed's "View pull request" placeholder when the number already says it.
  const prTitle =
    prNumber && event.resource?.label === "View pull request"
      ? undefined
      : event.resource?.label.replace(
          new RegExp(`^(?:PR )?#${prNumber ?? "\\d+"}(?: · |: | |$)`),
          ""
        ) || undefined;
  const prHeading =
    inline && (prNumber || event.resource) ? (
      <a
        href={prUrl}
        target="_blank"
        rel="noreferrer"
        className="min-w-0 font-medium text-foreground underline decoration-border underline-offset-4 [overflow-wrap:anywhere] focus-ring"
      >
        {prNumber && (
          <span className="font-mono text-muted-foreground">
            PR #{prNumber}
          </span>
        )}
        {prNumber && prTitle ? " " : null}
        {prTitle && <span className="font-sans">{prTitle}</span>}
      </a>
    ) : undefined;
  const header = (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      {prHeading ?? (
        <span className="font-medium [overflow-wrap:anywhere]">
          {event.summary}
        </span>
      )}
      {event.risk && (
        <Badge className={MERGE_RISK[event.risk].badge}>
          {MERGE_RISK[event.risk].label}
        </Badge>
      )}
      {status && !inline && (
        <Badge
          tone={
            status === "Failing"
              ? "danger"
              : status === "Passing"
                ? "success"
                : "neutral"
          }
        >
          {status}
        </Badge>
      )}
    </div>
  );
  if (inline)
    return (
      <div
        role="group"
        aria-label={`Dispatch system observation: ${event.summary}`}
        className="my-1 rounded-md border bg-card px-3 py-3 text-body-md"
      >
        <div className="flex items-start gap-2">
          {icon ?? (
            <Icon
              aria-hidden
              className={`mt-0.5 size-4 shrink-0 ${iconColor}`}
            />
          )}
          <div className="min-w-0 flex-1">
            {header}
            <PullRequestCheckResults
              text={event.details}
              notice={notice}
              status={status}
            />
            {visibleContent}
            {children}
            {/* Separators lead their item so a wrapped row never ends in "·". */}
            <div className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-label-sm text-muted-foreground">
              {time}
              {commit && (
                <span className="whitespace-nowrap">
                  <span aria-hidden>· </span>
                  {commit}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  return (
    <Collapsible
      role="group"
      aria-label={`Dispatch system observation: ${event.summary}`}
      defaultOpen={event.defaultOpen}
      className="my-1 rounded-md border bg-card px-3 py-3 text-body-md"
    >
      <div className="flex items-start gap-2">
        {icon ?? (
          <Icon aria-hidden className={`mt-0.5 size-4 shrink-0 ${iconColor}`} />
        )}
        <div className="min-w-0 flex-1">
          {header}
          {time}
          {visibleContent}
          {resource}
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-label-sm text-muted-foreground">
            {commit}
            <CollapsibleTrigger asChild>
              <Button
                variant="ghost"
                size="stream-sm"
                className="ml-auto h-5 gap-1 bg-transparent px-1 text-body-sm hover:bg-transparent hover:text-foreground focus-visible:bg-transparent data-[state=open]:bg-transparent"
              >
                Details
                <ChevronDown className="size-3" />
              </Button>
            </CollapsibleTrigger>
          </div>
        </div>
      </div>
      <CollapsibleContent className="mt-3 ml-6 border-t pt-3 font-sans text-body-md leading-relaxed">
        {event.details ? (
          <>
            <p className="mb-1 text-body-sm font-medium text-muted-foreground">
              Observation details
            </p>
            <div className="break-words">
              <Markdown>{event.details}</Markdown>
            </div>
          </>
        ) : null}
        {children}
        {event.category !== "info" ? (
          <p className="mt-3 text-body-sm text-muted-foreground">
            Informational · Not merge approval or authorization.
          </p>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  );
}
