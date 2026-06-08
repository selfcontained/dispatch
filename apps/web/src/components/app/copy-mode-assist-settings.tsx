import { useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { Checkbox } from "@/components/ui/checkbox";
import {
  AGENT_SETTINGS_QUERY_KEY,
  useAgentSettings,
} from "@/hooks/use-agent-settings";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

export function CopyModeAssistSettings(): JSX.Element {
  const queryClient = useQueryClient();
  const {
    data: agentSettings,
    error: queryError,
    isLoading,
  } = useAgentSettings();

  const mutation = useMutation({
    mutationFn: (nextEnabled: boolean) =>
      api<{ copyModeAssistEnabled: boolean }>("/api/v1/agents/settings", {
        method: "POST",
        body: JSON.stringify({ copyModeAssistEnabled: nextEnabled }),
      }),
    onMutate: async (nextEnabled) => {
      await queryClient.cancelQueries({ queryKey: AGENT_SETTINGS_QUERY_KEY });
      const previousSettings = queryClient.getQueryData(
        AGENT_SETTINGS_QUERY_KEY
      );
      queryClient.setQueryData(AGENT_SETTINGS_QUERY_KEY, (current) => ({
        ...(typeof current === "object" && current ? current : {}),
        copyModeAssistEnabled: nextEnabled,
      }));
      return { previousSettings };
    },
    onError: (_error, _nextEnabled, context) => {
      if (context?.previousSettings !== undefined) {
        queryClient.setQueryData(
          AGENT_SETTINGS_QUERY_KEY,
          context.previousSettings
        );
      }
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({
        queryKey: AGENT_SETTINGS_QUERY_KEY,
      });
    },
  });

  const enabled = agentSettings?.copyModeAssistEnabled ?? false;
  const saving = mutation.isPending;
  const errorMessage =
    mutation.error instanceof Error
      ? mutation.error.message
      : queryError instanceof Error
        ? queryError.message
        : "";

  const handleChange = useCallback(
    async (nextEnabled: boolean) => {
      await mutation.mutateAsync(nextEnabled);
    },
    [mutation]
  );

  return (
    <div>
      <div className="mb-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">
        Tmux scrollback assist
      </div>
      <p className="mb-3 max-w-2xl text-sm text-muted-foreground">
        Detect tmux copy mode, show the scrollback banner, and add a
        return-to-live shortcut. When off, Dispatch does not change tmux mouse
        mode or observe copy mode at all.
      </p>
      <label
        className={cn(
          "flex max-w-xl cursor-pointer items-center gap-3 rounded border border-border px-3 py-2.5 transition-colors hover:bg-muted/50",
          (saving || isLoading) && "pointer-events-none opacity-60"
        )}
      >
        <Checkbox
          checked={enabled}
          onCheckedChange={(value) => void handleChange(value === true)}
          disabled={saving || isLoading}
          data-testid="copy-mode-assist-toggle"
        />
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">
            Enable tmux scrollback assist
          </div>
          <div className="text-xs text-muted-foreground">
            Off by default. Turn on the passive copy-mode banner and
            return-to-live action.
          </div>
        </div>
      </label>
      {errorMessage ? (
        <p className="mt-2 text-xs text-destructive">{errorMessage}</p>
      ) : null}
    </div>
  );
}
