import { Check, Copy, GitBranch } from "lucide-react";
import { useCallback, useRef, useState } from "react";

import { BranchSelect } from "@/components/app/branch-select";
import { humanSchedule } from "@/components/app/jobs-helpers";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AGENT_TYPE_LABELS,
  type AgentType,
  type CliAgentType,
  isCliAgentType,
} from "@/lib/agent-types";
import { cn } from "@/lib/utils";

export function SwitchToggle({
  checked,
  onCheckedChange,
  ariaLabel,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "inline-flex h-6 w-11 shrink-0 items-center rounded-full border border-transparent p-0.5 transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background",
        checked ? "bg-primary" : "bg-muted"
      )}
    >
      <span
        className={cn(
          "h-5 w-5 rounded-full bg-background shadow-sm transition-transform",
          checked ? "translate-x-5" : "translate-x-0"
        )}
      />
    </button>
  );
}

export function JobScheduleField({
  id,
  schedule,
  scheduleError,
  enabled,
  enabledHelperText,
  onScheduleChange,
  onEnabledChange,
}: {
  id: string;
  schedule: string;
  scheduleError: string | null;
  enabled: boolean;
  enabledHelperText: string;
  onScheduleChange: (value: string) => void;
  onEnabledChange: (enabled: boolean) => void;
}) {
  return (
    <div className="min-w-0 space-y-1">
      <label className="text-sm text-muted-foreground" htmlFor={id}>
        Cron schedule{" "}
        <span className="text-muted-foreground/70">(optional)</span>
      </label>
      <Input
        id={id}
        value={schedule}
        onChange={(event) => onScheduleChange(event.target.value)}
        placeholder="*/30 * * * *"
        className="font-mono text-xs"
      />
      {scheduleError ? (
        <div className="text-xs text-status-blocked">{scheduleError}</div>
      ) : null}
      {!scheduleError && schedule.trim() ? (
        <div className="text-xs text-muted-foreground">
          {humanSchedule(schedule)}
        </div>
      ) : null}
      {!schedule.trim() ? (
        <div className="text-xs text-muted-foreground">
          Leave blank for an on-demand job.
        </div>
      ) : null}
      {schedule.trim() ? (
        <label className="mt-2 flex items-center justify-between gap-3 rounded-md border border-border/70 bg-muted/20 px-3 py-3 text-sm">
          <span>
            <span className="block font-medium text-foreground">Enabled</span>
            <span className="block text-xs text-muted-foreground">
              {enabledHelperText}
            </span>
          </span>
          <SwitchToggle
            checked={enabled}
            onCheckedChange={onEnabledChange}
            ariaLabel="Enable job"
          />
        </label>
      ) : null}
    </div>
  );
}

export function JobAgentTypeField({
  value,
  agentTypes,
  onChange,
}: {
  value: CliAgentType;
  agentTypes: AgentType[];
  onChange: (value: CliAgentType) => void;
}) {
  return (
    <div className="min-w-0 space-y-1">
      <label className="text-sm text-muted-foreground">Agent type</label>
      <Select
        value={value}
        onValueChange={(next) => onChange(next as CliAgentType)}
      >
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {agentTypes.filter(isCliAgentType).map((type) => (
            <SelectItem key={type} value={type}>
              {AGENT_TYPE_LABELS[type]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function JobWorktreeOption({
  checked,
  cwd,
  baseBranch,
  branchName,
  onCheckedChange,
  onBaseBranchChange,
  onBranchNameChange,
  testIdPrefix,
}: {
  checked: boolean;
  cwd: string;
  baseBranch: string;
  branchName: string;
  onCheckedChange: (checked: boolean) => void;
  onBaseBranchChange: (value: string) => void;
  onBranchNameChange: (value: string) => void;
  testIdPrefix?: string;
}) {
  return (
    <div className="space-y-2 rounded-md border border-border/70 bg-muted/20 px-3 py-3 md:col-span-2">
      <label className="flex cursor-pointer items-start gap-3">
        <Checkbox
          checked={checked}
          onCheckedChange={() => onCheckedChange(!checked)}
          className="mt-0.5"
          title="Toggle git worktree"
        />
        <span className="space-y-1">
          <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
            <GitBranch className="h-3.5 w-3.5" />
            Run in a git worktree
          </span>
          <span className="block text-xs text-muted-foreground">
            Creates an isolated worktree and branch when this job runs.
          </span>
        </span>
      </label>
      {checked ? (
        <div className="ml-8 w-[calc(100%-2rem)]">
          <BranchSelect
            cwd={cwd}
            baseBranch={baseBranch}
            onBaseBranchChange={onBaseBranchChange}
            worktreeBranch={branchName}
            onWorktreeBranchChange={onBranchNameChange}
            testIdPrefix={testIdPrefix ?? "job-worktree"}
          />
        </div>
      ) : null}
    </div>
  );
}

export function JobKeepAgentOption({
  checked,
  onCheckedChange,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border/70 bg-muted/20 px-3 py-3 md:col-span-2">
      <Checkbox
        checked={checked}
        onCheckedChange={() => onCheckedChange(!checked)}
        className="mt-0.5"
        title="Keep agent after run completes"
      />
      <span className="space-y-1">
        <span className="block text-sm font-medium text-foreground">
          Keep agent after run completes
        </span>
        <span className="block text-xs text-muted-foreground">
          The agent stays in your Agents list so you can continue the session
          after the job finishes.
        </span>
      </span>
    </label>
  );
}

export function JobFullAccessOption({
  checked,
  onCheckedChange,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border/70 bg-muted/20 px-3 py-3 md:col-span-2">
      <Checkbox
        checked={checked}
        onCheckedChange={() => onCheckedChange(!checked)}
        className="mt-0.5"
        title="Toggle full access"
      />
      <span className="space-y-1">
        <span className="block text-sm font-medium text-foreground">
          Run in full access mode
        </span>
        <span className="block text-xs text-muted-foreground">
          Starts the selected agent with its most permissive supported execution
          mode.
        </span>
      </span>
    </label>
  );
}

export function WebhookUrl({ secret }: { secret: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();
  const url = `${window.location.origin}/api/v1/jobs/webhook/${secret}`;

  const copy = useCallback(() => {
    void navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 2000);
    });
  }, [url]);

  return (
    <div className="mt-2 rounded-md border border-border/50 bg-muted/30 px-3 py-2.5">
      <div className="text-xs font-medium text-muted-foreground">
        Webhook URL
      </div>
      <div className="mt-1 flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate text-xs">{url}</code>
        <button
          type="button"
          className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground"
          onClick={copy}
          aria-label="Copy webhook URL"
        >
          {copied ? (
            <Check className="h-3.5 w-3.5 text-status-done" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
        </button>
      </div>
      <div className="mt-1 text-[11px] text-muted-foreground/70">
        POST to this URL to trigger a run. No auth header required.
      </div>
    </div>
  );
}
