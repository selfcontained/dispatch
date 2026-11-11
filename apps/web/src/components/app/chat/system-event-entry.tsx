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

/** Presentation model for the design checkpoint; no server-authorship contract yet. */
export interface SystemEventPresentation {
  category: "risk" | "checks" | "lifecycle" | "info";
  summary: string;
  risk?: keyof typeof MERGE_RISK;
  status?: "Passing" | "Failing" | "Pending";
  resource?: { label: string; url: string };
  head?: string;
  details: string;
  defaultOpen?: boolean;
}

export function SystemEventEntry({
  event,
}: {
  event: SystemEventPresentation;
}) {
  const Icon = {
    risk: ShieldCheck,
    checks: ListChecks,
    lifecycle: GitPullRequest,
    info: Info,
  }[event.category];
  const iconColor =
    event.risk === "human_review"
      ? "text-red-600"
      : event.status === "Failing"
        ? "text-destructive"
        : event.risk === "routine" || event.status === "Passing"
          ? "text-status-working"
          : event.status === "Pending" || event.risk === "abstain"
            ? "text-status-waiting"
            : event.category === "lifecycle"
              ? "text-status-done"
              : "text-primary";
  return (
    <Collapsible
      defaultOpen={event.defaultOpen}
      className="my-1 rounded-md border bg-card px-3 py-3 text-sm"
    >
      <div className="flex items-start gap-2">
        <Icon aria-hidden className={`mt-0.5 size-4 shrink-0 ${iconColor}`} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-medium [overflow-wrap:anywhere]">
              {event.summary}
            </span>
            {event.risk && (
              <Badge variant="default" className={MERGE_RISK[event.risk].badge}>
                {MERGE_RISK[event.risk].label}
              </Badge>
            )}
            {event.status && (
              <Badge
                variant="default"
                className={
                  event.status === "Failing"
                    ? "border-destructive/20 bg-destructive/10 text-destructive"
                    : event.status === "Passing"
                      ? "border-status-working/20 bg-status-working/10 text-status-working"
                      : "text-muted-foreground"
                }
              >
                {event.status}
              </Badge>
            )}
          </div>
          {event.resource && (
            <div className="mt-3 font-sans text-sm leading-snug">
              <a
                href={event.resource.url}
                className="min-w-0 break-words text-foreground underline decoration-border underline-offset-4 focus-visible:outline-ring"
              >
                {event.resource.label}
              </a>
            </div>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            <span>Dispatch · 10:42</span>
            {event.head && (
              <code title={event.head}>{event.head.slice(0, 7)}</code>
            )}
            <CollapsibleTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-5 gap-1 px-1 text-xs"
              >
                Details
                <ChevronDown className="size-3" />
              </Button>
            </CollapsibleTrigger>
          </div>
        </div>
      </div>
      <CollapsibleContent className="mt-3 ml-6 border-t pt-3 font-sans text-sm leading-relaxed">
        <p className="mb-1 text-xs font-medium text-muted-foreground">
          Observation details
        </p>
        <p className="whitespace-pre-wrap break-words">{event.details}</p>
        <p className="mt-3 text-xs text-muted-foreground">
          Informational · Not merge approval or authorization.
        </p>
      </CollapsibleContent>
    </Collapsible>
  );
}
