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
import { IconButton } from "@/components/ui/icon-button";
import { Switch } from "@/components/ui/switch";
import {
  AGENT_TYPE_LABELS,
  type AgentType,
  type CliAgentType,
  isCliAgentType,
} from "@/lib/agent-types";
import { Field } from "@/components/ui/field";
import { OptionCard, SettingRow } from "@/components/ui/setting-row";

export function SwitchToggle({
  checked,
  onCheckedChange,
  ariaLabel,
  disabled = false,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  ariaLabel: string;
  disabled?: boolean;
}) {
  return (
    <Switch
      checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onCheckedChange={onCheckedChange}
    />
  );
}

export function JobScheduleField({
  id,
  schedule,
  scheduleError,
  enabled,
  enabledHelperText,
  showEnabled = true,
  showEnabledWithoutSchedule = false,
  onScheduleChange,
  onEnabledChange,
}: {
  id: string;
  schedule: string;
  scheduleError: string | null;
  enabled: boolean;
  enabledHelperText: string;
  showEnabled?: boolean;
  showEnabledWithoutSchedule?: boolean;
  onScheduleChange: (value: string) => void;
  onEnabledChange: (enabled: boolean) => void;
}) {
  return (
    <div className="min-w-0 space-y-2">
      <Field
        id={id}
        label="Cron schedule"
        optional
        error={scheduleError}
        hint={
          schedule.trim()
            ? scheduleError
              ? null
              : humanSchedule(schedule)
            : "Leave blank for an on-demand job."
        }
      >
        <Input
          value={schedule}
          onChange={(event) => onScheduleChange(event.target.value)}
          placeholder="*/30 * * * *"
          className="font-mono text-body-sm"
        />
      </Field>
      {showEnabled && (schedule.trim() || showEnabledWithoutSchedule) ? (
        <SettingRow label="Enabled" description={enabledHelperText}>
          <SwitchToggle
            checked={enabled}
            onCheckedChange={onEnabledChange}
            ariaLabel="Enable job"
          />
        </SettingRow>
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
    <Field label="Agent type">
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
    </Field>
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
    <OptionCard
      className="md:col-span-2"
      label={
        <span className="flex items-center gap-1.5">
          <GitBranch className="size-icon-md" />
          Run in a git worktree
        </span>
      }
      description="Creates an isolated worktree and branch when this job runs."
      details={
        checked ? (
          <div className="ml-8">
            <BranchSelect
              cwd={cwd}
              baseBranch={baseBranch}
              onBaseBranchChange={onBaseBranchChange}
              worktreeBranch={branchName}
              onWorktreeBranchChange={onBranchNameChange}
              testIdPrefix={testIdPrefix ?? "job-worktree"}
            />
          </div>
        ) : null
      }
    >
      <Checkbox
        checked={checked}
        onCheckedChange={() => onCheckedChange(!checked)}
      />
    </OptionCard>
  );
}

export function JobKeepAgentOption({
  checked,
  onCheckedChange,
  disabled = false,
  helperText,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  helperText?: string;
}) {
  return (
    <OptionCard
      className="md:col-span-2"
      disabled={disabled}
      label="Keep agent after run completes"
      description={
        helperText ??
        "The agent stays in your Agents list so you can continue the session after the job finishes."
      }
    >
      <Checkbox
        checked={checked}
        onCheckedChange={() => onCheckedChange(!checked)}
        disabled={disabled}
      />
    </OptionCard>
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
    <OptionCard
      className="md:col-span-2"
      label="Run in full access mode"
      description="Starts the selected agent with its most permissive supported execution mode."
    >
      <Checkbox
        checked={checked}
        onCheckedChange={() => onCheckedChange(!checked)}
      />
    </OptionCard>
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
    <div className="mt-2 min-w-0 border-t border-border-subtle pt-3">
      <div className="text-body-sm font-medium text-muted-foreground">
        Webhook URL
      </div>
      <div className="mt-1 flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate text-body-sm">{url}</code>
        <IconButton
          size="icon-sm"
          label="Copy webhook URL"
          tooltip={copied ? "Copied" : "Copy webhook URL"}
          onClick={copy}
        >
          {copied ? <Check className="text-success" /> : <Copy />}
        </IconButton>
      </div>
      <div className="mt-1 text-label-sm text-faint">
        POST to this URL to trigger a run. No auth header required.
      </div>
    </div>
  );
}
