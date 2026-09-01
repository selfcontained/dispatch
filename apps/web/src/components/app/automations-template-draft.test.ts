import { describe, expect, it } from "vitest";

import {
  EMPTY_TEMPLATE_DRAFT,
  templateConfigFromDraft,
  templateDraftFrom,
  type TemplateDraft,
} from "@/components/app/automations-template-draft";
import type { Template } from "@/hooks/use-templates";

function draft(overrides: Partial<TemplateDraft> = {}): TemplateDraft {
  return { ...EMPTY_TEMPLATE_DRAFT, ...overrides };
}

function template(overrides: Partial<Template> = {}): Template {
  return {
    id: "tpl_1",
    directory: "/repo",
    name: "Nightly",
    description: null,
    prompt: null,
    agentType: "claude",
    model: null,
    useWorktree: false,
    baseBranch: null,
    branchName: null,
    fullAccess: false,
    callable: true,
    allowMedia: true,
    selfImprove: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("templateDraftFrom", () => {
  it("substitutes editable defaults for the record's nulls", () => {
    expect(templateDraftFrom(template())).toEqual({
      name: "Nightly",
      description: "",
      directory: "/repo",
      prompt: "",
      agentType: "claude",
      model: null,
      useWorktree: false,
      baseBranch: "main",
      branchName: "",
      fullAccess: false,
      callable: true,
      allowMedia: true,
      selfImprove: false,
    });
  });

  it("keeps stored values when the record has them", () => {
    expect(
      templateDraftFrom(
        template({
          description: "Runs nightly",
          prompt: "Do the thing",
          agentType: "codex",
          model: "gpt-5.5",
          useWorktree: true,
          baseBranch: "develop",
          branchName: "feat/x",
          fullAccess: true,
          callable: false,
          allowMedia: false,
          selfImprove: true,
        })
      )
    ).toEqual({
      name: "Nightly",
      description: "Runs nightly",
      directory: "/repo",
      prompt: "Do the thing",
      agentType: "codex",
      model: "gpt-5.5",
      useWorktree: true,
      baseBranch: "develop",
      branchName: "feat/x",
      fullAccess: true,
      callable: false,
      allowMedia: false,
      selfImprove: true,
    });
  });
});

describe("templateConfigFromDraft", () => {
  it("omits the branch fields when no worktree is requested", () => {
    const config = templateConfigFromDraft(
      draft({ useWorktree: false, baseBranch: "develop", branchName: "feat/x" })
    );
    expect(config.useWorktree).toBe(false);
    expect(config.baseBranch).toBeNull();
    expect(config.branchName).toBeNull();
  });

  it("sends the branch fields when a worktree is requested", () => {
    expect(
      templateConfigFromDraft(
        draft({
          useWorktree: true,
          baseBranch: "develop",
          branchName: "feat/x",
        })
      )
    ).toMatchObject({
      useWorktree: true,
      baseBranch: "develop",
      branchName: "feat/x",
    });
  });

  it("nulls an empty branch name but keeps the base branch", () => {
    expect(
      templateConfigFromDraft(
        draft({ useWorktree: true, baseBranch: "main", branchName: "" })
      )
    ).toMatchObject({ baseBranch: "main", branchName: null });
  });

  it("trims the description to null when it is blank", () => {
    expect(
      templateConfigFromDraft(draft({ description: "   " })).description
    ).toBeNull();
    expect(
      templateConfigFromDraft(draft({ description: "  hi  " })).description
    ).toBe("hi");
  });

  it("nulls an empty prompt", () => {
    expect(templateConfigFromDraft(draft({ prompt: "" })).prompt).toBeNull();
    expect(templateConfigFromDraft(draft({ prompt: "go" })).prompt).toBe("go");
  });

  it("collapses the agent-only fields for a terminal template", () => {
    expect(
      templateConfigFromDraft(
        draft({
          agentType: "terminal",
          prompt: "ignored",
          useWorktree: true,
          baseBranch: "develop",
          branchName: "feat/x",
          fullAccess: true,
          callable: false,
          allowMedia: true,
          selfImprove: true,
        })
      )
    ).toEqual({
      description: null,
      prompt: null,
      agentType: "terminal",
      useWorktree: false,
      baseBranch: null,
      branchName: null,
      fullAccess: false,
      callable: false,
      allowMedia: false,
      selfImprove: false,
    });
  });

  it("leaves callable alone for a terminal template", () => {
    expect(
      templateConfigFromDraft(draft({ agentType: "terminal", callable: true }))
        .callable
    ).toBe(true);
  });
});
