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
  return (
    <Collapsible className="my-1 rounded-md border bg-card px-3 py-2 text-sm">
      <div className="flex items-start gap-2">
        <Icon
          aria-hidden
          className="mt-0.5 size-4 shrink-0 text-muted-foreground"
        />
        <div className="min-w-0 flex-1 space-y-1">
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
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span>Dispatch · 10:42</span>
            {event.resource && (
              <a
                href={event.resource.url}
                className="min-w-0 break-words underline underline-offset-4 focus-visible:outline-ring"
              >
                {event.resource.label}
              </a>
            )}
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
      <CollapsibleContent className="pt-2 pl-6 text-xs text-muted-foreground">
        <p className="whitespace-pre-wrap break-words">{event.details}</p>
        <p className="mt-2">
          Informational · Not merge approval or authorization.
        </p>
      </CollapsibleContent>
    </Collapsible>
  );
}
