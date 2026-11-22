import { Check, GitBranch } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";

import { AgentModelSelect } from "@/components/app/agent-model-select";
import { AgentTypeSelect } from "@/components/app/agent-type-select";
import { Alert } from "@/components/ui/alert";
import {
  Dialog,
  DialogBody,
  DialogCancel,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { RowButton } from "@/components/ui/row-button";
import { StatusDot } from "@/components/ui/status-dot";
import { type AgentModelOption } from "@/hooks/use-agent-model-catalog";
import { type AgentType } from "@/lib/agent-types";
import { cn } from "@/lib/utils";

/** Mirrors MAX_LAUNCH_NOTE_LENGTH on the server. */
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
  showModelSelect,
  modelOptions,
  modelCatalogLoading,
  selectedModel,
  setSelectedModel,
  personas,
  selectedPersonas,
  setSelectedPersonas,
  codeownersAvailable,
  codeownersSelected,
  setCodeownersSelected,
  note,
  setNote,
  launchError,
  isLaunching,
  onResetLaunchError,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reviewerTypes: AgentType[];
  selectedAgentType: AgentType;
  setSelectedAgentType: Dispatch<SetStateAction<AgentType>>;
  showModelSelect: boolean;
  modelOptions: AgentModelOption[];
  modelCatalogLoading: boolean;
  selectedModel: string | null;
  setSelectedModel: (model: string | null) => void;
  personas: PersonaSummary[];
  selectedPersonas: string[];
  setSelectedPersonas: Dispatch<SetStateAction<string[]>>;
  /** The checkout has a .agents/owners.json to route reviewers by. */
  codeownersAvailable: boolean;
  /** Ask the agent to launch the code owners of its changed files. */
  codeownersSelected: boolean;
  setCodeownersSelected: (selected: boolean) => void;
  note: string;
  setNote: Dispatch<SetStateAction<string>>;
  /** The last launch attempt's failure, or null. */
  launchError: Error | null;
  /** True while a launch request is in flight. */
  isLaunching: boolean;
  /** Clears a stale launch error/result once the form changes. */
  onResetLaunchError: () => void;
  /** Submits the currently selected personas for launch. */
  onSubmit: () => void;
}): JSX.Element {
  const selectedCount = selectedPersonas.length + (codeownersSelected ? 1 : 0);
  const hasSelection = selectedCount > 0;
  const submitLabel = codeownersSelected
    ? selectedPersonas.length === 0
      ? "Launch code owners"
      : `Launch code owners + ${selectedPersonas.length} ${
          selectedPersonas.length > 1 ? "personas" : "persona"
        }`
    : selectedPersonas.length > 1
      ? `Launch ${selectedPersonas.length} personas`
      : "Launch persona";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <DialogContent busy={isLaunching}>
          <DialogHeader>
            <DialogTitle>Launch personas</DialogTitle>
            <DialogDescription>
              Let the code owners of the changed files review, pick personas by
              hand, or both. Each one runs as a child of this agent and posts
              what it produces into its stream — a reviewer posts a review block
              whose findings you and the agent resolve in threads.
            </DialogDescription>
          </DialogHeader>

          <DialogBody className="space-y-3">
            <div
              className={cn(
                "grid gap-3",
                showModelSelect && "min-[420px]:grid-cols-2"
              )}
            >
              <AgentTypeSelect
                label="Agent type"
                id="launch-reviewer-agent-type"
                testId="launch-reviewer-agent-type"
                value={selectedAgentType}
                agentTypes={reviewerTypes}
                onChange={(agentType) => {
                  setSelectedAgentType(agentType);
                  onResetLaunchError();
                }}
              />

              {showModelSelect ? (
                <AgentModelSelect
                  value={selectedModel}
                  options={modelOptions}
                  onChange={(model) => {
                    setSelectedModel(model);
                    onResetLaunchError();
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
                  className="text-body-sm font-medium text-foreground"
                >
                  Personas
                </span>
                {/* Live so toggling a row announces the running total,
                        which is otherwise only conveyed visually. */}
                <span
                  aria-live="polite"
                  className="text-body-sm text-muted-foreground"
                  data-testid="launch-reviewer-selected-count"
                >
                  {selectedCount > 0 ? `${selectedCount} selected` : ""}
                </span>
              </div>
              <div
                role="group"
                aria-labelledby="launch-reviewer-personas-label"
                className="space-y-2"
              >
                {/* Owner routing leads the list: it is the repo's own
                        answer to "who should look at this". */}
                <RowButton
                  role="checkbox"
                  selected={codeownersSelected}
                  aria-checked={codeownersSelected}
                  disabled={!codeownersAvailable}
                  onClick={() => {
                    setCodeownersSelected(!codeownersSelected);
                    onResetLaunchError();
                  }}
                  className={cn(
                    "items-start gap-3 border px-3 py-3",
                    codeownersSelected
                      ? "border-primary bg-surface-selected"
                      : "border-border-subtle bg-surface-subtle hover:bg-surface-hover",
                    !codeownersAvailable &&
                      "cursor-not-allowed opacity-60 hover:bg-surface-hover"
                  )}
                  data-testid="launch-reviewer-codeowners"
                >
                  <GitBranch className="mt-0.5 h-4 w-4 shrink-0 text-foreground/soft" />
                  <span className="min-w-0 flex-1 space-y-1">
                    <span className="block text-body-md font-medium">
                      Code owners
                    </span>
                    <span className="block text-body-sm text-muted-foreground">
                      {codeownersAvailable
                        ? "Route reviewers by the files this agent changed, using .agents/owners.json. Each matching owner launches once."
                        : "No .agents/owners.json in this checkout. Add ownership rules to route reviewers by changed files."}
                    </span>
                  </span>
                  <span
                    aria-hidden="true"
                    className={cn(
                      "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-xs border transition-colors",
                      codeownersSelected
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-transparent"
                    )}
                  >
                    <Check
                      className={cn(
                        "h-3 w-3",
                        codeownersSelected ? "opacity-100" : "opacity-0"
                      )}
                    />
                  </span>
                </RowButton>
                {personas.map((persona, index) => {
                  const colorVar = `var(--chart-${(index % 4) + 1})`;
                  const isSelected = selectedPersonas.includes(persona.slug);
                  return (
                    <RowButton
                      key={persona.slug}
                      role="checkbox"
                      selected={isSelected}
                      aria-checked={isSelected}
                      onClick={() => {
                        setSelectedPersonas((prev) =>
                          prev.includes(persona.slug)
                            ? prev.filter((slug) => slug !== persona.slug)
                            : [...prev, persona.slug]
                        );
                        onResetLaunchError();
                      }}
                      className={cn(
                        "items-start gap-3 border px-3 py-3",
                        isSelected
                          ? "border-primary bg-surface-selected"
                          : "border-border-subtle bg-surface-subtle hover:bg-surface-hover"
                      )}
                      data-testid={`launch-reviewer-persona-${persona.slug}`}
                    >
                      <StatusDot
                        color={`hsl(${colorVar})`}
                        className="mt-1.5"
                      />
                      <span className="min-w-0 flex-1 space-y-1">
                        <span
                          className="block text-body-md font-medium"
                          style={{ color: `hsl(${colorVar})` }}
                        >
                          {persona.name}
                        </span>
                        {persona.description ? (
                          <span className="block text-body-sm text-muted-foreground">
                            {persona.description}
                          </span>
                        ) : null}
                      </span>
                      <span
                        aria-hidden="true"
                        className={cn(
                          "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-xs border transition-colors",
                          isSelected
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border bg-transparent"
                        )}
                      >
                        <Check
                          className={cn(
                            "h-3 w-3",
                            isSelected ? "opacity-100" : "opacity-0"
                          )}
                        />
                      </span>
                    </RowButton>
                  );
                })}
              </div>
            </div>

            <Field
              id="launch-reviewer-note"
              label="What should they focus on?"
              optional
              hint="Added to the briefing each persona receives."
            >
              <Textarea
                value={note}
                onChange={(e) => {
                  setNote(e.target.value);
                  onResetLaunchError();
                }}
                maxLength={MAX_NOTE_LENGTH}
                rows={3}
                placeholder="e.g. focus on the auth changes in session.ts — I'm unsure about the token refresh path"
                className="resize-none text-body-md"
                data-testid="launch-reviewer-note"
              />
            </Field>
          </DialogBody>
          {launchError ? (
            <Alert
              title="Couldn’t launch the personas."
              error={launchError}
              data-testid="launch-reviewer-error"
            />
          ) : null}
          <DialogFooter>
            <DialogCancel />
            <Button
              type="button"
              variant="primary"
              pending={isLaunching}
              disabled={
                !hasSelection ||
                // Launching mid-load would send model: null and silently
                // drop the stored preference the select is about to show.
                modelCatalogLoading
              }
              onClick={() => {
                if (!hasSelection) return;
                onSubmit();
              }}
              data-testid="launch-reviewer-submit"
            >
              {submitLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
