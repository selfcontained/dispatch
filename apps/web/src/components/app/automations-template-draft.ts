import { useMemo, useState, type Dispatch, type SetStateAction } from "react";

import type { TemplateConfigFieldsProps } from "@/components/app/automations-form-fields";
import type { AddTemplateConfig, Template } from "@/hooks/use-templates";
import type { AgentType } from "@/lib/agent-types";

/** The editable fields behind `<TemplateConfigFields>`, as a single value. */
export interface TemplateDraft {
  name: string;
  description: string;
  directory: string;
  prompt: string;
  agentType: AgentType;
  model: string | null;
  useWorktree: boolean;
  baseBranch: string;
  branchName: string;
  fullAccess: boolean;
  callable: boolean;
  allowFiles: boolean;
  selfImprove: boolean;
}

/** Starting point for the create dialog, which has no template to hydrate from. */
export const EMPTY_TEMPLATE_DRAFT: TemplateDraft = {
  name: "",
  description: "",
  directory: "",
  prompt: "",
  agentType: "claude",
  model: null,
  useWorktree: false,
  baseBranch: "main",
  branchName: "",
  fullAccess: false,
  callable: true,
  allowFiles: true,
  selfImprove: false,
};

/** Starting point for the detail pane, which edits an existing template. */
export function templateDraftFrom(template: Template): TemplateDraft {
  return {
    name: template.name,
    description: template.description ?? "",
    directory: template.directory,
    prompt: template.prompt ?? "",
    agentType: template.agentType,
    model: template.model,
    useWorktree: template.useWorktree,
    baseBranch: template.baseBranch ?? "main",
    branchName: template.branchName ?? "",
    fullAccess: template.fullAccess,
    callable: template.callable,
    allowFiles: template.allowFiles,
    selfImprove: template.selfImprove,
  };
}

/**
 * The submit fields the create dialog and the detail pane derive identically
 * from the draft: a terminal session has no prompt, worktree, access mode,
 * files or self-improve, and the branch fields only travel when a worktree is
 * requested. `name`, `directory` and `model` are deliberately absent — each
 * surface applies its own trimming/normalization to those.
 */
export function templateConfigFromDraft(
  draft: TemplateDraft
): Required<
  Pick<
    AddTemplateConfig,
    | "description"
    | "prompt"
    | "agentType"
    | "useWorktree"
    | "baseBranch"
    | "branchName"
    | "fullAccess"
    | "callable"
    | "allowFiles"
    | "selfImprove"
  >
> {
  return {
    description: draft.description.trim() || null,
    prompt: draft.prompt || null,
    agentType: draft.agentType,
    useWorktree: draft.useWorktree,
    baseBranch: draft.useWorktree ? draft.baseBranch : null,
    branchName: draft.useWorktree ? draft.branchName || null : null,
    fullAccess: draft.fullAccess,
    callable: draft.callable,
    allowFiles: draft.allowFiles,
    selfImprove: draft.selfImprove,
  };
}

/** The value/onChange half of `<TemplateConfigFields>`'s props. */
export type TemplateDraftFieldProps = Omit<
  TemplateConfigFieldsProps,
  "enabledAgentTypes" | "autoFocusName"
>;

export interface TemplateDraftController {
  draft: TemplateDraft;
  setDraft: Dispatch<SetStateAction<TemplateDraft>>;
  /** Spread straight into `<TemplateConfigFields>`. */
  fieldProps: TemplateDraftFieldProps;
}

/**
 * Holds the template form state and the per-field change handlers both
 * automations surfaces need. The handlers are created once, matching the
 * stability of the `useState` setters they replace.
 */
export function useTemplateDraft(
  initial: TemplateDraft
): TemplateDraftController {
  const [draft, setDraft] = useState(initial);

  const changeHandlers = useMemo(
    () => ({
      onNameChange: (value: string) =>
        setDraft((prev) => ({ ...prev, name: value })),
      onDescriptionChange: (value: string) =>
        setDraft((prev) => ({ ...prev, description: value })),
      onDirectoryChange: (value: string) =>
        setDraft((prev) => ({ ...prev, directory: value })),
      onPromptChange: (value: string) =>
        setDraft((prev) => ({ ...prev, prompt: value })),
      onAgentTypeChange: (value: AgentType) =>
        setDraft((prev) => ({ ...prev, agentType: value })),
      onModelChange: (value: string | null) =>
        setDraft((prev) => ({ ...prev, model: value })),
      onUseWorktreeChange: (checked: boolean) =>
        setDraft((prev) => ({ ...prev, useWorktree: checked })),
      onBaseBranchChange: (value: string) =>
        setDraft((prev) => ({ ...prev, baseBranch: value })),
      onBranchNameChange: (value: string) =>
        setDraft((prev) => ({ ...prev, branchName: value })),
      onFullAccessChange: (checked: boolean) =>
        setDraft((prev) => ({ ...prev, fullAccess: checked })),
      onCallableChange: (checked: boolean) =>
        setDraft((prev) => ({ ...prev, callable: checked })),
      onAllowFilesChange: (checked: boolean) =>
        setDraft((prev) => ({ ...prev, allowFiles: checked })),
      onSelfImproveChange: (checked: boolean) =>
        setDraft((prev) => ({ ...prev, selfImprove: checked })),
    }),
    []
  );

  return { draft, setDraft, fieldProps: { ...draft, ...changeHandlers } };
}
