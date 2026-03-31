import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, CheckCircle2, Info, X } from "lucide-react";

import { type Agent, type FeedbackItem } from "@/components/app/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

const SEVERITY_CONFIG: Record<string, { color: string; icon: typeof AlertTriangle }> = {
  critical: { color: "text-red-500", icon: AlertTriangle },
  high: { color: "text-orange-500", icon: AlertTriangle },
  medium: { color: "text-yellow-500", icon: AlertTriangle },
  low: { color: "text-blue-400", icon: Info },
  info: { color: "text-muted-foreground", icon: Info },
};

export function FeedbackPanel({
  agent,
  agents,
  sendTerminalInput,
  connectedAgentId,
}: {
  agent: Agent;
  agents: Agent[];
  sendTerminalInput?: (data: string) => void;
  connectedAgentId?: string | null;
}): JSX.Element | null {
  const queryClient = useQueryClient();

  const { data: feedback = [] } = useQuery<FeedbackItem[]>({
    queryKey: ["feedback", agent.id],
    queryFn: async () => {
      const result = await api<{ feedback: FeedbackItem[] }>(`/api/v1/agents/${agent.id}/feedback`);
      return result.feedback;
    },
  });

  const openItems = feedback.filter((f) => f.status === "open");

  if (feedback.length === 0) return null;

  const parentAgent = agent.parentAgentId
    ? agents.find((a) => a.id === agent.parentAgentId)
    : null;

  const updateStatus = async (id: number, status: "dismissed" | "forwarded") => {
    await api(`/api/v1/agents/${agent.id}/feedback/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    });
    queryClient.setQueryData<FeedbackItem[]>(["feedback", agent.id], (old) =>
      old?.map((f) => (f.id === id ? { ...f, status } : f))
    );
  };

  const forwardToParent = async (item: FeedbackItem) => {
    if (!parentAgent || !sendTerminalInput || connectedAgentId !== parentAgent.id) return;

    const parts = [`[Feedback from ${agent.persona ?? "persona"}]`];
    if (item.filePath) parts.push(`File: ${item.filePath}${item.lineNumber ? `:${item.lineNumber}` : ""}`);
    parts.push(`Severity: ${item.severity}`);
    parts.push(item.description);
    if (item.suggestion) parts.push(`Suggestion: ${item.suggestion}`);

    sendTerminalInput(parts.join("\n") + "\n");
    await updateStatus(item.id, "forwarded");
  };

  return (
    <div className="mt-2 space-y-1.5">
      <div className="flex items-center justify-between text-[10px] uppercase tracking-wide text-muted-foreground/80">
        <span>Feedback ({openItems.length} open)</span>
      </div>
      {feedback.map((item) => {
        const config = SEVERITY_CONFIG[item.severity] ?? SEVERITY_CONFIG.info;
        const Icon = config.icon;
        const isOpen = item.status === "open";

        return (
          <div
            key={item.id}
            className={cn(
              "rounded border px-2 py-1.5 text-xs",
              isOpen ? "border-border bg-muted/30" : "border-transparent opacity-50"
            )}
          >
            <div className="flex items-start gap-1.5">
              <Icon className={cn("mt-0.5 h-3 w-3 shrink-0", config.color)} />
              <div className="min-w-0 flex-1">
                {item.filePath ? (
                  <div className="truncate font-mono text-[10px] text-muted-foreground">
                    {item.filePath}{item.lineNumber ? `:${item.lineNumber}` : ""}
                  </div>
                ) : null}
                <div className="text-foreground">{item.description}</div>
                {item.suggestion ? (
                  <div className="mt-0.5 text-muted-foreground">
                    {item.suggestion}
                  </div>
                ) : null}
              </div>
              <Badge
                className="shrink-0 text-[9px]"
                variant={item.severity === "critical" || item.severity === "high" ? "error" : "default"}
              >
                {item.severity}
              </Badge>
            </div>
            {isOpen ? (
              <div className="mt-1.5 flex items-center gap-1">
                {parentAgent && sendTerminalInput && connectedAgentId === parentAgent.id ? (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-5 gap-1 px-1.5 text-[10px]"
                          onClick={() => forwardToParent(item)}
                        >
                          <ArrowRight className="h-2.5 w-2.5" />
                          Forward
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Send to {parentAgent.name}</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                ) : null}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 gap-1 px-1.5 text-[10px] text-muted-foreground"
                  onClick={() => updateStatus(item.id, "dismissed")}
                >
                  <X className="h-2.5 w-2.5" />
                  Dismiss
                </Button>
                {item.status === "forwarded" ? (
                  <span className="flex items-center gap-0.5 text-[10px] text-green-500">
                    <CheckCircle2 className="h-2.5 w-2.5" /> Forwarded
                  </span>
                ) : null}
              </div>
            ) : (
              <div className="mt-1 text-[10px] text-muted-foreground">
                {item.status === "forwarded" ? (
                  <span className="flex items-center gap-0.5 text-green-500">
                    <CheckCircle2 className="h-2.5 w-2.5" /> Forwarded
                  </span>
                ) : (
                  "Dismissed"
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
