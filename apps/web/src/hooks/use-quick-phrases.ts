import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useStore } from "jotai";

import { api } from "@/lib/api";
import { chatDraftAtomFamily } from "@/lib/store";
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
  const store = useStore();
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
  });

  const deletePhrase = useMutation({
    mutationFn: (id: string) =>
      api<null>(`/api/v1/quick-phrases/${id}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });

  const injectPhrase = useMutation({
    mutationFn: (input: {
      agentId: string;
      phraseId: string;
      args?: Record<string, string>;
      submit?: boolean;
    }) =>
      // Submitted, the server posts the rendered phrase as a Chat message and
      // answers 204; unsubmitted, it answers with the text for the composer.
      api<{ text: string } | null>(
        `/api/v1/agents/${encodeURIComponent(input.agentId)}/prompts/phrase`,
        {
          method: "POST",
          body: JSON.stringify({
            phraseId: input.phraseId,
            args: input.args,
            submit: input.submit,
          }),
        }
      ),
    onSuccess: (result, input) => {
      if (result?.text) {
        const draftAtom = chatDraftAtomFamily(input.agentId);
        const draft = store.get(draftAtom);
        const text = draft.text.trim()
          ? `${draft.text.replace(/\s+$/, "")}\n${result.text}`
          : result.text;
        store.set(draftAtom, { ...draft, text });
      }
      callbacks?.onInjected?.();
    },
  });

  return {
    createPhrase,
    updatePhrase,
    deletePhrase,
    injectPhrase,
    isSaving: createPhrase.isPending || updatePhrase.isPending,
  };
}
