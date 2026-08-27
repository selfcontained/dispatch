import { Check, ChevronDown } from "lucide-react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { UseMutationResult } from "@tanstack/react-query";

import { AgentModelSelect } from "@/components/app/agent-model-select";
import { AgentTypeIcon } from "@/components/app/agent-type-icon";
import {
  Command,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { type AgentModelOption } from "@/hooks/use-agent-model-catalog";
import { swallowEscapeFromCombobox } from "@/lib/dialog-escape";
import { AGENT_TYPE_LABELS, type AgentType } from "@/lib/agent-types";
import { cn } from "@/lib/utils";

/** Mirrors MAX_LAUNCH_REVIEW_NOTE_LENGTH on the server. */
const MAX_NOTE_LENGTH = 2000;

type PersonaSummary = {
  slug: string;
  name: string;
  description: string;
};

export function PersonaLauncherDialog({
  open,
  onOpenChange,
  reviewerTypes,
  selectedAgentType,
  setSelectedAgentType,
  typeDropdownOpen,
  setTypeDropdownOpen,
  typeCmdRef,
  typeTriggerRef,
  showModelSelect,
  modelOptions,
  modelCatalogLoading,
  selectedModel,
  setSelectedModel,
  personas,
  selectedPersonas,
  setSelectedPersonas,
  note,
  setNote,
  launchMutation,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reviewerTypes: AgentType[];
  selectedAgentType: AgentType;
  setSelectedAgentType: Dispatch<SetStateAction<AgentType>>;
  typeDropdownOpen: boolean;
  setTypeDropdownOpen: Dispatch<SetStateAction<boolean>>;
  typeCmdRef: RefObject<HTMLDivElement>;
  typeTriggerRef: RefObject<HTMLButtonElement>;
  showModelSelect: boolean;
  modelOptions: AgentModelOption[];
  modelCatalogLoading: boolean;
  selectedModel: string | null;
  setSelectedModel: (model: string | null) => void;
  personas: PersonaSummary[];
  selectedPersonas: string[];
  setSelectedPersonas: Dispatch<SetStateAction<string[]>>;
  note: string;
  setNote: Dispatch<SetStateAction<string>>;
  launchMutation: UseMutationResult<void, unknown, string[], unknown>;
}): JSX.Element {
  const launchErrorMessage =
    launchMutation.error instanceof Error ? launchMutation.error.message : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <DialogContent
          onEscapeKeyDown={(e) => {
            swallowEscapeFromCombobox(e);
            if (e.defaultPrevented) return;
            if (typeDropdownOpen) {
              e.preventDefault();
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>Launch Review</DialogTitle>
            <DialogDescription>
              Pick one or more reviewer personas and a review agent type. Each
              reviewer will submit one tracked review, with follow-up discussion
              kept in its feedback item threads.
            </DialogDescription>
          </DialogHeader>

          <div className="flex min-h-0 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto px-1">
              <div className="space-y-3">
                <div
                  className={cn(
                    "grid gap-3",
                    showModelSelect && "min-[420px]:grid-cols-2"
                  )}
                >
                  <div className="relative space-y-1" ref={typeCmdRef}>
                    <label className="text-sm text-muted-foreground">
                      Agent type
                    </label>
                    <button
                      ref={typeTriggerRef}
                      type="button"
                      role="combobox"
                      aria-expanded={typeDropdownOpen}
                      onClick={() => setTypeDropdownOpen((prev) => !prev)}
                      onKeyDown={(e) => {
                        if (
                          e.key === "ArrowDown" ||
                          e.key === "Enter" ||
                          e.key === " "
                        ) {
                          e.preventDefault();
                          if (!typeDropdownOpen) setTypeDropdownOpen(true);
                        }
                      }}
                      className={cn(
                        "flex h-9 w-full items-center justify-between rounded-md border border-white/[0.12] bg-white/[0.04] px-3 py-2 text-sm shadow-[inset_0_2px_6px_rgba(0,0,0,0.3)] backdrop-blur-md",
                        "ring-offset-background focus:outline-none focus:ring-1 focus:ring-ring"
                      )}
                      data-testid="launch-reviewer-agent-type"
                    >
                      <span className="flex items-center gap-2">
                        <AgentTypeIcon
                          type={selectedAgentType}
                          className="h-4 w-4 border-none bg-transparent p-0 text-foreground/80"
                        />
                        {AGENT_TYPE_LABELS[selectedAgentType]}
                      </span>
                      <ChevronDown
                        className={cn(
                          "h-4 w-4 text-muted-foreground transition-transform",
                          typeDropdownOpen && "rotate-180"
                        )}
                      />
                    </button>
                    {typeDropdownOpen ? (
                      <div className="absolute left-0 right-0 z-[80] mt-1 rounded-md border border-white/[0.2] bg-[hsl(var(--card))] shadow-[0_16px_64px_rgba(0,0,0,0.5),inset_0_1px_0_rgba(255,255,255,0.15)] backdrop-blur-2xl">
                        <Command
                          shouldFilter={false}
                          ref={(el) => {
                            if (el) requestAnimationFrame(() => el.focus());
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Escape") {
                              e.preventDefault();
                              setTypeDropdownOpen(false);
                              requestAnimationFrame(() =>
                                typeTriggerRef.current?.focus()
                              );
                            }
                          }}
                        >
                          <CommandList>
                            <CommandGroup>
                              {reviewerTypes.map((agentType) => (
                                <CommandItem
                                  key={agentType}
                                  value={agentType}
                                  onSelect={() => {
                                    setSelectedAgentType(agentType);
                                    launchMutation.reset();
                                    setTypeDropdownOpen(false);
                                    requestAnimationFrame(() =>
                                      typeTriggerRef.current?.focus()
                                    );
                                  }}
                                >
                                  <Check
                                    className={cn(
                                      "mr-2 h-3 w-3 shrink-0",
                                      agentType === selectedAgentType
                                        ? "opacity-100"
                                        : "opacity-0"
                                    )}
                                  />
                                  {AGENT_TYPE_LABELS[agentType]}
                                </CommandItem>
                              ))}
                            </CommandGroup>
                          </CommandList>
                        </Command>
                      </div>
                    ) : null}
                  </div>

                  {showModelSelect ? (
                    <AgentModelSelect
                      value={selectedModel}
                      options={modelOptions}
                      onChange={(model) => {
                        setSelectedModel(model);
                        launchMutation.reset();
                      }}
                      loading={modelCatalogLoading}
                      id="launch-reviewer-model"
                      testId="launch-reviewer-model"
                    />
                  ) : null}
                </div>

                <div className="space-y-2">
                  <div className="flex items-baseline justify-between">
                    <span
                      id="launch-reviewer-personas-label"
                      className="text-sm text-muted-foreground"
                    >
                      Personas
                    </span>
                    {/* Live so toggling a row announces the running total,
                        which is otherwise only conveyed visually. */}
                    <span
                      aria-live="polite"
                      className="text-xs text-muted-foreground"
                      data-testid="launch-reviewer-selected-count"
                    >
                      {selectedPersonas.length > 0
                        ? `${selectedPersonas.length} selected`
                        : ""}
                    </span>
                  </div>
                  <div
                    role="group"
                    aria-labelledby="launch-reviewer-personas-label"
                    className="space-y-2"
                  >
                    {personas.map((persona, index) => {
                      const colorVar = `var(--chart-${(index % 4) + 1})`;
                      const isSelected = selectedPersonas.includes(
                        persona.slug
                      );
                      return (
                        <button
                          key={persona.slug}
                          type="button"
                          role="checkbox"
                          aria-checked={isSelected}
                          onClick={() => {
                            setSelectedPersonas((prev) =>
                              prev.includes(persona.slug)
                                ? prev.filter((slug) => slug !== persona.slug)
                                : [...prev, persona.slug]
                            );
                            launchMutation.reset();
                          }}
                          className={cn(
                            "flex w-full items-start gap-3 rounded-md border px-3 py-3 text-left transition-colors",
                            isSelected
                              ? "border-primary bg-primary/10"
                              : "border-border/70 bg-muted/20 hover:bg-muted/35"
                          )}
                          data-testid={`launch-reviewer-persona-${persona.slug}`}
                        >
                          <span
                            className="mt-1.5 h-2 w-2 shrink-0 rounded-full"
                            style={{ backgroundColor: `hsl(${colorVar})` }}
                          />
                          <span className="min-w-0 flex-1 space-y-1">
                            <span
                              className="block text-sm font-medium"
                              style={{ color: `hsl(${colorVar})` }}
                            >
                              {persona.name}
                            </span>
                            {persona.description ? (
                              <span className="block text-xs text-muted-foreground">
                                {persona.description}
                              </span>
                            ) : null}
                          </span>
                          <span
                            aria-hidden="true"
                            className={cn(
                              "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors",
                              isSelected
                                ? "border-primary bg-primary text-primary-foreground"
                                : "border-border/80 bg-transparent"
                            )}
                          >
                            <Check
                              className={cn(
                                "h-3 w-3",
                                isSelected ? "opacity-100" : "opacity-0"
                              )}
                            />
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="space-y-1">
                  <label
                    htmlFor="launch-reviewer-note"
                    className="text-sm text-muted-foreground"
                  >
                    What should they focus on?{" "}
                    <span className="text-xs">(optional)</span>
                  </label>
                  <Textarea
                    id="launch-reviewer-note"
                    value={note}
                    onChange={(e) => {
                      setNote(e.target.value);
                      launchMutation.reset();
                    }}
                    maxLength={MAX_NOTE_LENGTH}
                    rows={3}
                    placeholder="e.g. focus on the auth changes in session.ts — I'm unsure about the token refresh path"
                    className="resize-none text-sm"
                    data-testid="launch-reviewer-note"
                  />
                  <p className="text-xs text-muted-foreground">
                    Added to the briefing each reviewer receives.
                  </p>
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-3">
              {launchErrorMessage ? (
                <p
                  className="mr-auto max-w-[28rem] text-sm text-destructive"
                  data-testid="launch-reviewer-error"
                >
                  {launchErrorMessage}
                </p>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="primary"
                disabled={
                  selectedPersonas.length === 0 ||
                  launchMutation.isPending ||
                  // Launching mid-load would send model: null and silently
                  // drop the stored preference the select is about to show.
                  modelCatalogLoading
                }
                onClick={() => {
                  if (selectedPersonas.length === 0) return;
                  void launchMutation.mutateAsync(selectedPersonas);
                }}
                data-testid="launch-reviewer-submit"
              >
                {selectedPersonas.length > 1
                  ? `Launch ${selectedPersonas.length} Reviews`
                  : "Launch Review"}
              </Button>
            </div>
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
