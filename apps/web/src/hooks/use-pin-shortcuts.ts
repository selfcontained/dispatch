import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

import { api } from "@/lib/api";

/**
 * Fires a shortcut pin: the server looks the prompt up by pin ID, posts it as
 * a Chat message and delivers it as the agent's next turn.
 */
export function useRunPinShortcut() {
  return useMutation({
    mutationFn: (input: { agentId: string; pinId: string; label?: string }) =>
      api<null>(
        `/api/v1/agents/${encodeURIComponent(input.agentId)}/prompts/pin/${encodeURIComponent(input.pinId)}`,
        { method: "POST" }
      ),
    // Naming the shortcut keeps stacked toasts distinguishable when several
    // are fired in a row.
    onSuccess: (_data, variables) =>
      toast.success(
        variables.label ? `Sent "${variables.label}" to agent` : "Sent to agent"
      ),
    onError: (error: unknown) =>
      toast.error(
        error instanceof Error ? error.message : "Failed to send shortcut"
      ),
  });
}
