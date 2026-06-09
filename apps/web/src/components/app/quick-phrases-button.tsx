import { useCallback, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageSquare, Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { toast } from "sonner";

import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

type QuickPhrase = {
  id: string;
  text: string;
  sortOrder: number;
  createdAt: string;
};

export function QuickPhrasesButton({
  agentId,
  focusTerminal,
}: {
  agentId: string;
  focusTerminal: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [newText, setNewText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: ["quick-phrases"],
    queryFn: () => api<{ phrases: QuickPhrase[] }>("/api/v1/quick-phrases"),
    staleTime: 60_000,
  });

  const phrases = data?.phrases ?? [];

  const createMutation = useMutation({
    mutationFn: (text: string) =>
      api<{ phrase: QuickPhrase }>("/api/v1/quick-phrases", {
        method: "POST",
        body: JSON.stringify({ text }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["quick-phrases"] });
      setNewText("");
      inputRef.current?.focus();
    },
    onError: () => toast.error("Failed to save phrase"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      api<null>(`/api/v1/quick-phrases/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["quick-phrases"] });
    },
    onError: () => toast.error("Failed to delete phrase"),
  });

  const injectMutation = useMutation({
    mutationFn: (text: string) =>
      api<null>(`/api/v1/agents/${agentId}/terminal/inject`, {
        method: "POST",
        body: JSON.stringify({ text }),
      }),
    onSuccess: () => {
      setOpen(false);
      focusTerminal();
    },
    onError: () => toast.error("Failed to send phrase"),
  });

  const handleAdd = useCallback(() => {
    const trimmed = newText.trim();
    if (!trimmed) return;
    createMutation.mutate(trimmed);
  }, [newText, createMutation]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          className="pointer-events-auto"
          title="Quick phrases"
          data-testid="quick-phrases-button"
        >
          <MessageSquare className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <div className="border-b border-border px-3 py-2">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Quick Phrases
          </h4>
        </div>
        <div className="max-h-64 overflow-y-auto">
          {phrases.length === 0 ? (
            <div className="px-3 py-4 text-center text-xs text-muted-foreground">
              No phrases yet — add one below
            </div>
          ) : (
            phrases.map((phrase) => (
              <div
                key={phrase.id}
                className="group flex items-center gap-1 border-b border-border/50 last:border-b-0"
              >
                <button
                  type="button"
                  className={cn(
                    "flex-1 truncate px-3 py-2 text-left text-sm text-foreground hover:bg-white/[0.06]",
                    injectMutation.isPending && "pointer-events-none opacity-50"
                  )}
                  onClick={() => {
                    if (injectMutation.isPending) return;
                    injectMutation.mutate(phrase.text);
                  }}
                  title={phrase.text}
                >
                  {phrase.text}
                </button>
                <button
                  type="button"
                  className="mr-1 hidden rounded p-1 text-muted-foreground hover:bg-white/[0.1] hover:text-foreground group-hover:block group-focus-within:block"
                  onClick={() => deleteMutation.mutate(phrase.id)}
                  title="Remove phrase"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))
          )}
        </div>
        <form
          className="flex items-center gap-1 border-t border-border p-2"
          onSubmit={(e) => {
            e.preventDefault();
            handleAdd();
          }}
        >
          <Input
            ref={inputRef}
            value={newText}
            onChange={(e) => setNewText(e.target.value)}
            placeholder="Add a phrase…"
            className="h-7 flex-1 text-xs"
            maxLength={1000}
          />
          <Button
            type="submit"
            size="icon"
            variant="ghost"
            className="h-7 w-7 shrink-0"
            disabled={!newText.trim() || createMutation.isPending}
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}
