import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { api } from "@/lib/api";
import type { TemplateArg } from "@/hooks/use-templates";

export type QuickPhrase = {
  id: string;
  label: string | null;
  text: string;
  args: TemplateArg[];
  sortOrder: number;
  createdAt: string;
};

export function useQuickPhrases() {
  return useQuery({
    queryKey: ["quick-phrases"],
    queryFn: () => api<{ phrases: QuickPhrase[] }>("/api/v1/quick-phrases"),
    staleTime: 60_000,
  });
}

export function useQuickPhraseActions(callbacks?: {
  onSaved?: () => void;
  onInjected?: () => void;
}) {
  const queryClient = useQueryClient();
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["quick-phrases"] });

  const createPhrase = useMutation({
    mutationFn: (input: { label?: string; text: string }) =>
      api<{ phrase: QuickPhrase }>("/api/v1/quick-phrases", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      invalidate();
      callbacks?.onSaved?.();
    },
    onError: () => toast.error("Failed to save phrase"),
  });

  const updatePhrase = useMutation({
    mutationFn: ({
      id,
      ...fields
    }: {
      id: string;
      label?: string | null;
      text?: string;
    }) =>
      api<{ phrase: QuickPhrase }>(`/api/v1/quick-phrases/${id}`, {
        method: "PATCH",
        body: JSON.stringify(fields),
      }),
    onSuccess: () => {
      invalidate();
      callbacks?.onSaved?.();
    },
    onError: () => toast.error("Failed to update phrase"),
  });

  const deletePhrase = useMutation({
    mutationFn: (id: string) =>
      api<null>(`/api/v1/quick-phrases/${id}`, { method: "DELETE" }),
    onSuccess: invalidate,
    onError: () => toast.error("Failed to delete phrase"),
  });

  const injectPhrase = useMutation({
    mutationFn: (input: {
      agentId: string;
      phraseId: string;
      args?: Record<string, string>;
      submit?: boolean;
    }) =>
      api<null>(`/api/v1/agents/${input.agentId}/terminal/inject-phrase`, {
        method: "POST",
        body: JSON.stringify({
          phraseId: input.phraseId,
          args: input.args,
          submit: input.submit,
        }),
      }),
    onSuccess: () => callbacks?.onInjected?.(),
    onError: () => toast.error("Failed to send phrase"),
  });

  return {
    createPhrase,
    updatePhrase,
    deletePhrase,
    injectPhrase,
    isSaving: createPhrase.isPending || updatePhrase.isPending,
  };
}
