import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

import { api } from "@/lib/api";

/**
 * Fires a shortcut pin: the server looks the prompt up by pin ID and delivers
 * it to the owning agent's session, exactly as if the user had typed it.
 */
export function useRunPinShortcut() {
  return useMutation({
    mutationFn: (input: { agentId: string; pinId: string }) =>
      api<null>(`/api/v1/agents/${input.agentId}/pins/${input.pinId}/run`, {
        method: "POST",
      }),
    onSuccess: () => toast.success("Sent to agent"),
    onError: (error: unknown) =>
      toast.error(
        error instanceof Error ? error.message : "Failed to send action"
      ),
  });
}
