import { describe, expect, it } from "vitest";
import type { BlockFormData } from "@dispatch/shared";
import {
  ACTION,
  SLACK_LIMITS,
  formMessage,
  formModal,
  parseFormSubmission,
  questionMessage,
  settledMessage,
} from "../src/notifications/slack-blocks.js";

const ctx = {
  ref: "n1",
  agentName: "builder-7",
  context: "Dispatch · Task: Fix login",
  text: "Which database should the migration target?",
  openUrl: "http://lan:6767/agents/agt_1?block=b1",
};

const actionsOf = (blocks: Record<string, any>[]) =>
  blocks.find((b) => b.type === "actions")!.elements as Record<string, any>[];

describe("questionMessage", () => {
  it("renders options as buttons carrying only opaque ref:index values", () => {
    const out = questionMessage(
      {
        options: [
          { label: "Postgres", value: "secret-pg-value" },
          { label: "SQLite" },
        ],
        allowFreeform: true,
      },
      ctx
    );
    expect(out.unsupported).toEqual([]);
    const elements = actionsOf(out.blocks);
    expect(elements.map((e) => e.value)).toEqual([
      "n1:0",
      "n1:1",
      "n1",
      undefined,
    ]);
    expect(JSON.stringify(out.blocks)).not.toContain("secret-pg-value");
    expect(elements[2]!.action_id).toBe(ACTION.freeform);
    expect(elements[3]!.url).toBe(ctx.openUrl);
  });

  it("never emits mrkdwn so agent text can't ping @channel or inject links", () => {
    const out = questionMessage(
      { options: [{ label: "ok" }] },
      { ...ctx, text: "<!channel> see <http://evil|here>" }
    );
    const json = JSON.stringify(out.blocks);
    expect(json).not.toContain('"mrkdwn"');
    expect(out.blocks.find((b) => b.type === "section")).toMatchObject({
      text: { type: "plain_text", text: "<!channel> see <http://evil|here>" },
    });
  });

  it("falls back to Open in Dispatch with explicit reasons instead of dropping", () => {
    const out = questionMessage(
      { options: [{ label: "x".repeat(80) }, { label: "fine" }] },
      { ...ctx, text: "q".repeat(3500) }
    );
    expect(out.unsupported).toEqual([
      "the question is 3500 characters (Slack shows 3000)",
      "1 option label is longer than Slack allows",
    ]);
    const elements = actionsOf(out.blocks);
    expect(elements).toHaveLength(1);
    expect(elements[0]!.action_id).toBe(ACTION.open);
    expect(JSON.stringify(out.blocks)).toContain("Answer in Dispatch:");
    const section = out.blocks.find((b) => b.type === "section") as any;
    expect(section.text.text).toHaveLength(SLACK_LIMITS.sectionText);
    expect(section.text.text.endsWith("…")).toBe(true);
  });

  it("keeps Dispatch-only (gate) and parent-handled asks out of Slack answering", () => {
    for (const out of [
      questionMessage(
        { options: [{ label: "Merge" }] },
        { ...ctx, dispatchOnly: true }
      ),
      questionMessage(
        { options: [{ label: "Merge" }], parentHandled: true },
        ctx
      ),
    ]) {
      expect(out.unsupported.length).toBeGreaterThan(0);
      expect(actionsOf(out.blocks).map((e) => e.action_id)).toEqual([
        ACTION.open,
      ]);
    }
  });
});

const form: BlockFormData = {
  title: "Release details for the next rollout",
  submitLabel: "Ship",
  fields: [
    { id: "version", label: "Version", type: "text", required: true },
    {
      id: "notes",
      label: "Notes",
      type: "textarea",
      placeholder: "p".repeat(200),
    },
    {
      id: "pct",
      label: "Rollout %",
      type: "number",
      required: true,
      value: 10,
    },
    {
      id: "channel",
      label: "Channel",
      type: "select",
      required: true,
      options: [{ label: "Stable", value: "stable-v" }, { label: "Beta" }],
    },
    { id: "notify", label: "Notify users", type: "checkbox", required: true },
  ],
};

describe("form adapters", () => {
  it("builds a modal within Slack limits preserving labels, required and typed inputs", () => {
    const view = formModal(form, "n2", "builder-7 · Dispatch") as any;
    expect(view.title.text).toHaveLength(SLACK_LIMITS.modalTitle);
    expect(view.submit.text).toBe("Ship");
    expect(view.private_metadata).toBe("n2");
    const inputs = view.blocks.filter((b: any) => b.type === "input");
    expect(
      inputs.map((b: any) => [b.block_id, b.element.type, b.optional])
    ).toEqual([
      ["f0", "plain_text_input", false],
      ["f1", "plain_text_input", true],
      ["f2", "number_input", false],
      ["f3", "static_select", false],
      ["f3_other", "plain_text_input", true],
      ["f4", "checkboxes", true],
    ]);
    expect(inputs[1].element.placeholder.text).toHaveLength(
      SLACK_LIMITS.placeholder
    );
    expect(inputs[2].element.initial_value).toBe("10");
    expect(inputs[3].element.options.map((o: any) => o.value)).toEqual([
      "0",
      "1",
      "__other__",
    ]);
    expect(JSON.stringify(view)).not.toContain("stable-v");
  });

  it("maps submission back onto stored option values and types", () => {
    const parsed = parseFormSubmission(form, {
      f0: { value: { type: "plain_text_input", value: "1.8.0" } },
      f1: { value: { type: "plain_text_input", value: "" } },
      f2: { value: { type: "number_input", value: "12.5" } },
      f3: { value: { type: "static_select", selected_option: { value: "0" } } },
      f4: { value: { type: "checkboxes", selected_options: [] } },
    });
    expect(parsed).toEqual({
      values: {
        version: "1.8.0",
        pct: 12.5,
        channel: "stable-v",
        notify: false,
      },
    });
  });

  it("reports required, Other and forged option errors inline", () => {
    expect(
      parseFormSubmission(form, {
        f2: { value: { value: "abc" } },
        f3: { value: { selected_option: { value: "7" } } },
      })
    ).toEqual({
      errors: {
        f0: "Required.",
        f2: "Enter a number.",
        f3: "Choose one of the listed options.",
      },
    });
    expect(
      parseFormSubmission(form, {
        f0: { value: { value: "v" } },
        f2: { value: { value: "1" } },
        f3: { value: { selected_option: { value: "__other__" } } },
        f3_other: { value: { value: "  " } },
      })
    ).toEqual({ errors: { f3_other: "Type a value for Other." } });
    expect(
      parseFormSubmission(form, {
        f0: { value: { value: "v" } },
        f2: { value: { value: "1" } },
        f3: { value: { selected_option: { value: "__other__" } } },
        f3_other: { value: { value: "nightly" } },
      })
    ).toMatchObject({ values: { channel: "nightly", notify: false } });
  });

  it("shows unsupported forms with reasons and no Fill in button", () => {
    const big: BlockFormData = {
      fields: [
        {
          id: "region",
          label: "Region",
          type: "select",
          options: Array.from({ length: 140 }, (_, i) => ({ label: `r${i}` })),
        },
      ],
    };
    expect(formModal(big, "n3", "c")).toBeNull();
    const out = formMessage(big, ctx);
    expect(out.unsupported).toEqual(['field "Region" has 140 options']);
    expect(actionsOf(out.blocks).map((e) => e.action_id)).toEqual([
      ACTION.open,
    ]);
    const ok = formMessage(form, ctx);
    expect(ok.unsupported).toEqual([]);
    expect(actionsOf(ok.blocks)[0]).toMatchObject({
      action_id: ACTION.form,
      value: "n1",
    });
    expect(JSON.stringify(ok.blocks)).toContain("5 fields, 4 required");
  });
});

describe("settledMessage", () => {
  it("removes actions and states recorded vs delivery truthfully", () => {
    const out = settledMessage(ctx, {
      kind: "answered",
      by: "@brad",
      via: "slack",
      summary: '"Postgres"',
      delivery: "not_delivered",
    });
    expect(actionsOf(out.blocks).map((e) => e.action_id)).toEqual([
      ACTION.open,
    ]);
    expect(out.text).toContain(
      "recorded · not delivered to the agent yet — open Dispatch to retry"
    );
    expect(out.text).not.toMatch(/picked up/);
  });
});
