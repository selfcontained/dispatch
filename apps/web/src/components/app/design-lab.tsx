import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ArrowRight,
  Bot,
  CheckCircle2,
  FolderKanban,
  MessageSquareText,
  Sparkles,
  Wand2,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { THEMES, useTheme, type ThemeId } from "@/hooks/use-theme";
import { cn } from "@/lib/utils";

type JobHelperMode = "idle" | "drafting" | "review" | "question";
type AgentHelperMode = "idle" | "drafting" | "review";

type JobDraft = {
  name: string;
  directory: string;
  prompt: string;
  schedule: string;
  timeout: string;
  callable: boolean;
  singleton: boolean;
};

type AgentDraft = {
  name: string;
  directory: string;
  instructions: string;
  context: string;
};

type JobPatch = {
  key: keyof JobDraft;
  label: string;
  nextValue: string | boolean;
  note: string;
};

type AgentPatch = {
  key: keyof AgentDraft;
  label: string;
  nextValue: string;
  note: string;
};

const JOB_INITIAL: JobDraft = {
  name: "nightly-pr-triage",
  directory: "~/code/dispatch",
  prompt: "",
  schedule: "",
  timeout: "30",
  callable: true,
  singleton: true,
};

const JOB_PROMPT = `Review new and updated pull requests in this repository.

- Triage open PRs that changed in the last 24 hours.
- Summarize risk, missing tests, and blocked CI.
- When a small fix is obvious, propose the exact next step.
- Post a concise status summary grouped by PR.
- Escalate only when human review or missing context is required.`;

const AGENT_INITIAL: AgentDraft = {
  name: "release-sherpa",
  directory: "~/code/dispatch",
  instructions: "",
  context:
    "Needs to help with release prep, changelog review, and deployment coordination.",
};

const AGENT_INSTRUCTIONS = `You are Dispatch's release operations copilot.

- Prioritize correctness over speed.
- Verify release state before suggesting changes.
- Summarize risks, rollout steps, and rollback paths.
- Keep updates concise and operational.
- Ask for confirmation before suggesting any destructive action.`;

function ThemePicker({
  theme,
  setTheme,
}: {
  theme: ThemeId;
  setTheme: (id: ThemeId) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="mr-1 text-xs uppercase tracking-wide text-muted-foreground">
        Theme
      </span>
      {THEMES.map((t) => (
        <button
          key={t.id}
          onClick={() => setTheme(t.id)}
          className={cn(
            "group flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs transition-colors",
            theme === t.id
              ? "border-primary bg-primary/10 text-foreground"
              : "border-border bg-card text-muted-foreground hover:text-foreground"
          )}
          title={t.description}
        >
          <span className="flex gap-0.5">
            {t.swatches.slice(0, 3).map((swatch, i) => (
              <span
                key={i}
                className="h-3 w-3 rounded-sm border border-black/20"
                style={{ backgroundColor: swatch }}
              />
            ))}
          </span>
          {t.label}
        </button>
      ))}
    </div>
  );
}

function SectionHeader({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="space-y-1">
      <h2 className="text-2xl font-semibold tracking-tight text-foreground">
        {title}
      </h2>
      <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
        {description}
      </p>
    </div>
  );
}

function PillButton({
  active,
  children,
  onClick,
}: {
  active?: boolean;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
        active
          ? "border-primary/50 bg-primary/15 text-foreground"
          : "border-border bg-background/70 text-muted-foreground hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  onToggle,
}: {
  label: string;
  description: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center justify-between gap-4 rounded-xl border border-border/70 bg-background/55 px-4 py-3 text-left"
    >
      <span>
        <span className="block text-sm font-medium text-foreground">
          {label}
        </span>
        <span className="block text-xs text-muted-foreground">
          {description}
        </span>
      </span>
      <span
        className={cn(
          "inline-flex h-6 w-11 shrink-0 items-center rounded-full p-0.5 transition-colors",
          checked ? "bg-primary" : "bg-muted"
        )}
      >
        <span
          className={cn(
            "h-5 w-5 rounded-full bg-background shadow-sm transition-transform",
            checked ? "translate-x-5" : "translate-x-0"
          )}
        />
      </span>
    </button>
  );
}

function FieldBlock({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label className="text-sm text-muted-foreground">{label}</label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function Textarea({
  value,
  onChange,
  placeholder,
  rows = 8,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  rows?: number;
}) {
  return (
    <textarea
      rows={rows}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      className="w-full rounded-xl border border-white/[0.12] bg-white/[0.04] px-3 py-2 text-sm text-foreground shadow-[inset_0_2px_6px_rgba(0,0,0,0.24)] backdrop-blur-md placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
    />
  );
}

function HelperShell({
  title,
  subtitle,
  status,
  actions,
  children,
  footer,
}: {
  title: string;
  subtitle: string;
  status: string;
  actions: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <Card className="border-white/[0.12] bg-[linear-gradient(180deg,rgba(255,255,255,0.07),rgba(255,255,255,0.03))]">
      <CardHeader className="space-y-4 border-b border-border/60">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Badge variant="running">{status}</Badge>
              <span className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                Hidden helper
              </span>
            </div>
            <CardTitle className="text-xl">{title}</CardTitle>
            <CardDescription className="max-w-sm">{subtitle}</CardDescription>
          </div>
          <div className="rounded-2xl border border-primary/20 bg-primary/10 p-3 text-primary">
            <Bot className="h-5 w-5" />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">{actions}</div>
      </CardHeader>
      <CardContent className="space-y-4 p-4">{children}</CardContent>
      {footer ? (
        <div className="border-t border-border/60 px-4 py-3 text-xs text-muted-foreground">
          {footer}
        </div>
      ) : null}
    </Card>
  );
}

function PatchCard({
  label,
  preview,
  note,
  onApply,
}: {
  label: string;
  preview: ReactNode;
  note: string;
  onApply: () => void;
}) {
  return (
    <div className="rounded-xl border border-border/70 bg-background/55 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="text-sm font-medium text-foreground">{label}</div>
          <div className="text-xs text-muted-foreground">{note}</div>
        </div>
        <Button size="sm" variant="ghost" onClick={onApply}>
          Apply
        </Button>
      </div>
      <div className="mt-3 rounded-lg border border-border/70 bg-card/60 p-3 text-sm text-foreground">
        {preview}
      </div>
    </div>
  );
}

function ActivityItem({
  title,
  body,
  active,
}: {
  title: string;
  body: string;
  active?: boolean;
}) {
  return (
    <div className="flex gap-3">
      <div className="mt-1 flex flex-col items-center">
        <span
          className={cn(
            "h-2.5 w-2.5 rounded-full",
            active
              ? "bg-primary shadow-[0_0_16px_hsl(var(--primary)/0.55)]"
              : "bg-muted-foreground/50"
          )}
        />
        <span className="mt-1 h-full w-px bg-border/70" />
      </div>
      <div className="pb-4">
        <div className="text-sm font-medium text-foreground">{title}</div>
        <div className="mt-1 text-xs leading-5 text-muted-foreground">
          {body}
        </div>
      </div>
    </div>
  );
}

function HelperQuestion({
  question,
  answers,
  onAnswer,
}: {
  question: string;
  answers: string[];
  onAnswer: (answer: string) => void;
}) {
  return (
    <div className="rounded-xl border border-status-waiting/35 bg-status-waiting/10 p-4">
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        <MessageSquareText className="h-4 w-4 text-status-waiting" />
        Helper follow-up
      </div>
      <p className="mt-2 text-sm text-muted-foreground">{question}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {answers.map((answer) => (
          <Button
            key={answer}
            size="sm"
            variant="ghost-warning"
            onClick={() => onAnswer(answer)}
          >
            {answer}
          </Button>
        ))}
      </div>
    </div>
  );
}

function JobAssistPrototype() {
  const [draft, setDraft] = useState<JobDraft>(JOB_INITIAL);
  const [mode, setMode] = useState<JobHelperMode>("idle");
  const [note, setNote] = useState(
    "Nightly job that helps me keep PRs moving without spamming people."
  );

  const patches = useMemo<JobPatch[]>(() => {
    const items: JobPatch[] = [];
    if (!draft.prompt.trim()) {
      items.push({
        key: "prompt",
        label: "Prompt draft",
        nextValue: JOB_PROMPT,
        note: "Turns the loose goal into an unattended nightly triage run.",
      });
    }
    if (!draft.schedule.trim()) {
      items.push({
        key: "schedule",
        label: "Schedule recommendation",
        nextValue: "0 7 * * 1-5",
        note: "Weekday mornings reduce overnight notification noise.",
      });
    }
    if (draft.timeout !== "45") {
      items.push({
        key: "timeout",
        label: "Timeout adjustment",
        nextValue: "45",
        note: "Gives the agent enough time to inspect several PRs and CI state.",
      });
    }
    return items;
  }, [draft.prompt, draft.schedule, draft.timeout]);

  const applyJobPatch = (patch: JobPatch) => {
    setDraft((current) => ({ ...current, [patch.key]: patch.nextValue }));
    setMode("review");
  };

  return (
    <section className="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(360px,0.8fr)]">
      <Card className="border-white/[0.12] bg-card/35">
        <CardHeader className="border-b border-border/60">
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle className="text-xl">Create Job</CardTitle>
              <CardDescription>
                Prototype for a form-scoped helper that drafts the prompt,
                suggests defaults, and asks narrow follow-ups.
              </CardDescription>
            </div>
            <Badge variant="default">Form focus</Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-5 p-4">
          <div className="grid gap-4 md:grid-cols-2">
            <FieldBlock label="Name">
              <Input
                value={draft.name}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    name: event.target.value,
                  }))
                }
              />
            </FieldBlock>
            <FieldBlock
              label="Working directory"
              hint="Directory gates helper availability in the real flow."
            >
              <Input
                value={draft.directory}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    directory: event.target.value,
                  }))
                }
              />
            </FieldBlock>
          </div>

          <div className="rounded-2xl border border-primary/20 bg-primary/8 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <Sparkles className="h-4 w-4 text-primary" />
                  Help configure this job
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  Hidden helper stays attached to the open form, not the user’s
                  visible agent list.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => setMode("drafting")}
                >
                  Draft prompt
                </Button>
                <Button size="sm" onClick={() => setMode("question")}>
                  Find gaps
                </Button>
              </div>
            </div>
            <div className="mt-3 rounded-xl border border-border/70 bg-background/60 p-3">
              <label className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
                What I want this help with
              </label>
              <Textarea
                value={note}
                onChange={setNote}
                placeholder="Describe the kind of job you want..."
                rows={3}
              />
            </div>
          </div>

          <FieldBlock
            label="Prompt"
            hint="Helper patches should feel like improvements to this field, not a detached conversation."
          >
            <Textarea
              value={draft.prompt}
              onChange={(next) =>
                setDraft((current) => ({ ...current, prompt: next }))
              }
              placeholder="Describe what the agent should do..."
              rows={11}
            />
          </FieldBlock>

          <div className="grid gap-4 md:grid-cols-2">
            <FieldBlock
              label="Cron schedule"
              hint="Leave blank for on-demand jobs."
            >
              <Input
                value={draft.schedule}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    schedule: event.target.value,
                  }))
                }
                placeholder="0 7 * * 1-5"
              />
            </FieldBlock>
            <FieldBlock
              label="Run timeout, minutes"
              hint="Prototyping helper-suggested defaults."
            >
              <Input
                value={draft.timeout}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    timeout: event.target.value,
                  }))
                }
              />
            </FieldBlock>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <ToggleRow
              label="Show in command palette"
              description="Callable jobs get a quick launch affordance."
              checked={draft.callable}
              onToggle={() =>
                setDraft((current) => ({
                  ...current,
                  callable: !current.callable,
                }))
              }
            />
            <ToggleRow
              label="Single instance"
              description="Prevent overlapping runs while one is active."
              checked={draft.singleton}
              onToggle={() =>
                setDraft((current) => ({
                  ...current,
                  singleton: !current.singleton,
                }))
              }
            />
          </div>
        </CardContent>
      </Card>

      <HelperShell
        title="Job helper"
        subtitle="Assists with prompt quality, sensible defaults, and missing configuration."
        status={
          mode === "idle"
            ? "ready"
            : mode === "drafting"
              ? "working"
              : mode === "question"
                ? "waiting"
                : "applied"
        }
        actions={
          <>
            <PillButton
              active={mode === "drafting"}
              onClick={() => setMode("drafting")}
            >
              Draft prompt
            </PillButton>
            <PillButton
              active={mode === "review"}
              onClick={() => setMode("review")}
            >
              Review patches
            </PillButton>
            <PillButton
              active={mode === "question"}
              onClick={() => setMode("question")}
            >
              Ask follow-up
            </PillButton>
          </>
        }
        footer="Prototype intent: no transcript-first UX. The form remains primary, helper state remains secondary."
      >
        <div className="rounded-xl border border-border/70 bg-background/45 p-3">
          <div className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
            Current context
          </div>
          <div className="mt-2 text-sm leading-6 text-foreground">
            <span className="font-medium">Goal:</span> {note}
          </div>
          <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
            <span className="rounded-full border border-border/70 px-2 py-1">
              cwd: {draft.directory || "not selected"}
            </span>
            <span className="rounded-full border border-border/70 px-2 py-1">
              prompt {draft.prompt.trim() ? "present" : "missing"}
            </span>
            <span className="rounded-full border border-border/70 px-2 py-1">
              schedule {draft.schedule.trim() ? "set" : "unset"}
            </span>
          </div>
        </div>

        {mode === "idle" ? (
          <div className="rounded-xl border border-dashed border-border bg-background/35 p-5 text-sm text-muted-foreground">
            Summon help from an action above. This state is intentionally not a
            chat box by default.
          </div>
        ) : null}

        {mode === "drafting" || mode === "review" ? (
          <div className="space-y-3">
            {patches.map((patch) => (
              <PatchCard
                key={patch.key}
                label={patch.label}
                note={patch.note}
                preview={
                  typeof patch.nextValue === "string" ? (
                    <div className="whitespace-pre-wrap">{patch.nextValue}</div>
                  ) : (
                    <div>{patch.nextValue ? "Enabled" : "Disabled"}</div>
                  )
                }
                onApply={() => applyJobPatch(patch)}
              />
            ))}
            <div className="rounded-xl border border-status-done/30 bg-status-done/10 p-3 text-sm text-muted-foreground">
              The helper can stack multiple suggested field patches without
              taking over the entire form.
            </div>
          </div>
        ) : null}

        {mode === "question" ? (
          <HelperQuestion
            question="Should this run automatically on weekday mornings, or stay on-demand until the prompt has been tested?"
            answers={[
              "Weekday mornings",
              "Keep it on-demand",
              "Ask me again later",
            ]}
            onAnswer={(answer) => {
              if (answer === "Weekday mornings") {
                setDraft((current) => ({
                  ...current,
                  schedule: "0 7 * * 1-5",
                }));
              }
              setMode("review");
            }}
          />
        ) : null}

        <div className="rounded-xl border border-border/70 bg-background/45 p-4">
          <div className="mb-3 flex items-center gap-2 text-sm font-medium text-foreground">
            <FolderKanban className="h-4 w-4 text-primary" />
            Interaction model
          </div>
          <ActivityItem
            title="1. User asks for a specific kind of help"
            body="Actions stay goal-shaped: draft, improve, configure, or find gaps."
            active={mode === "idle"}
          />
          <ActivityItem
            title="2. Hidden helper emits field patches"
            body="Patches are reviewed inline and can be applied one field at a time."
            active={mode === "drafting" || mode === "review"}
          />
          <ActivityItem
            title="3. Narrow follow-up clarifies the missing bit"
            body="Questions appear as a task continuation, not a fresh chat session."
            active={mode === "question"}
          />
        </div>
      </HelperShell>
    </section>
  );
}

function AgentAssistPrototype() {
  const [draft, setDraft] = useState<AgentDraft>(AGENT_INITIAL);
  const [mode, setMode] = useState<AgentHelperMode>("idle");

  const patches = useMemo<AgentPatch[]>(() => {
    const items: AgentPatch[] = [];
    if (!draft.instructions.trim()) {
      items.push({
        key: "instructions",
        label: "Instruction draft",
        nextValue: AGENT_INSTRUCTIONS,
        note: "Transforms the role description into enforceable operating instructions.",
      });
    }
    if (!draft.name.trim().includes("release")) {
      items.push({
        key: "name",
        label: "Name refinement",
        nextValue: "release-sherpa",
        note: "Shorter name that matches the operating context.",
      });
    }
    return items;
  }, [draft.instructions, draft.name]);

  const applyPatch = (patch: AgentPatch) => {
    setDraft((current) => ({ ...current, [patch.key]: patch.nextValue }));
    setMode("review");
  };

  return (
    <section className="grid gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(340px,0.85fr)]">
      <Card className="border-white/[0.12] bg-card/35">
        <CardHeader className="border-b border-border/60">
          <CardTitle className="text-xl">Create Agent</CardTitle>
          <CardDescription>
            Same helper model, but focused on role instructions and missing
            context rather than schedules and run settings.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5 p-4">
          <div className="grid gap-4 md:grid-cols-2">
            <FieldBlock label="Name">
              <Input
                value={draft.name}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    name: event.target.value,
                  }))
                }
              />
            </FieldBlock>
            <FieldBlock label="Working directory">
              <Input
                value={draft.directory}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    directory: event.target.value,
                  }))
                }
              />
            </FieldBlock>
          </div>

          <div className="rounded-2xl border border-primary/20 bg-primary/8 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <Wand2 className="h-4 w-4 text-primary" />
                  Help write instructions
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  The helper turns rough goals into sharper operating rules and
                  identifies missing context.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => setMode("drafting")}
                >
                  Draft instructions
                </Button>
                <Button size="sm" onClick={() => setMode("review")}>
                  Review suggestions
                </Button>
              </div>
            </div>
          </div>

          <FieldBlock
            label="Context"
            hint="In the real flow this could come from files, links, or freeform context."
          >
            <Textarea
              value={draft.context}
              onChange={(next) =>
                setDraft((current) => ({ ...current, context: next }))
              }
              placeholder="What should this agent help with?"
              rows={4}
            />
          </FieldBlock>

          <FieldBlock
            label="Instructions"
            hint="This prototype explores helper-authored instruction blocks, not a full agent chat."
          >
            <Textarea
              value={draft.instructions}
              onChange={(next) =>
                setDraft((current) => ({ ...current, instructions: next }))
              }
              placeholder="You are an agent that..."
              rows={12}
            />
          </FieldBlock>
        </CardContent>
      </Card>

      <HelperShell
        title="Agent instruction helper"
        subtitle="Optimizes role clarity, constraints, and context completeness."
        status={
          mode === "idle"
            ? "ready"
            : mode === "drafting"
              ? "working"
              : "applied"
        }
        actions={
          <>
            <PillButton
              active={mode === "drafting"}
              onClick={() => setMode("drafting")}
            >
              Draft instructions
            </PillButton>
            <PillButton
              active={mode === "review"}
              onClick={() => setMode("review")}
            >
              Review gaps
            </PillButton>
          </>
        }
        footer="Second prototype checks whether the same helper shell adapts cleanly to a different form shape."
      >
        <div className="rounded-xl border border-border/70 bg-background/45 p-4">
          <div className="text-sm font-medium text-foreground">
            What the helper thinks is missing
          </div>
          <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
            <li className="flex items-start gap-2">
              <ArrowRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
              Define what the agent should never do.
            </li>
            <li className="flex items-start gap-2">
              <ArrowRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
              Clarify whether it can suggest commands or only summarize status.
            </li>
            <li className="flex items-start gap-2">
              <ArrowRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
              State the target audience for updates: engineer, release owner, or
              both.
            </li>
          </ul>
        </div>

        {mode !== "idle" ? (
          <div className="space-y-3">
            {patches.map((patch) => (
              <PatchCard
                key={patch.key}
                label={patch.label}
                note={patch.note}
                preview={
                  <div className="whitespace-pre-wrap">{patch.nextValue}</div>
                }
                onApply={() => applyPatch(patch)}
              />
            ))}
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-border bg-background/35 p-5 text-sm text-muted-foreground">
            This variant keeps the same helper shell, but the value is narrower:
            better instructions, not whole-form configuration.
          </div>
        )}

        <div className="rounded-xl border border-status-done/30 bg-status-done/10 p-4">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <CheckCircle2 className="h-4 w-4 text-status-done" />
            UX question to evaluate
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            Does the same sidecar feel right for both full-form configuration
            and single-artifact authoring, or should prompt/instruction help use
            a smaller inline treatment?
          </p>
        </div>
      </HelperShell>
    </section>
  );
}

export function DesignLab() {
  const { theme, setTheme } = useTheme();
  const [active, setActive] = useState<"job" | "agent">("job");

  useEffect(() => {
    const style = document.createElement("style");
    style.textContent =
      "html, body, #root { overflow: auto !important; height: auto !important; }";
    document.head.appendChild(style);
    return () => {
      style.remove();
    };
  }, []);

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,rgba(255,255,255,0.08),transparent_35%),radial-gradient(circle_at_top_right,rgba(255,255,255,0.05),transparent_30%),linear-gradient(180deg,hsl(var(--background)),hsl(var(--background)))] p-6 md:p-8">
      <div className="mx-auto max-w-[1520px] space-y-8">
        <header className="space-y-3">
          <SectionHeader
            title="Design Lab"
            description="Prototyping hidden in-form helper agents for Create Job and Create Agent. The goal here is to validate how assistance should feel before locking down session semantics or helper tooling."
          />
        </header>

        <div className="sticky top-0 z-10 flex flex-wrap items-center gap-4 rounded-2xl border border-border bg-background/82 px-4 py-3 backdrop-blur">
          <ThemePicker theme={theme} setTheme={setTheme} />
          <div className="h-6 w-px bg-border/80" />
          <div className="flex flex-wrap gap-2">
            <PillButton
              active={active === "job"}
              onClick={() => setActive("job")}
            >
              Job flow
            </PillButton>
            <PillButton
              active={active === "agent"}
              onClick={() => setActive("agent")}
            >
              Agent flow
            </PillButton>
          </div>
        </div>

        {active === "job" ? <JobAssistPrototype /> : <AgentAssistPrototype />}
      </div>
    </div>
  );
}
