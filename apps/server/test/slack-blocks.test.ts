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
  MARKDOWN_MAX,
  notifyMessage,
} from "../src/notifications/slack-blocks.js";

const ctx = {
  ref: "n1",
  agentName: "builder-7",
  context: "Dispatch · Task: Fix login",
  text: "Which database should the migration target?",
  openUrl: "http://lan:6767/agents/agt_1?block=b1",
};

const actionsOf = (blocks: Record<string, any>[]) =>
  (blocks.find((b) => b.type === "actions")?.elements ?? []) as Record<
    string,
    any
  >[];

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
    expect(elements.map((e) => e.value)).toEqual(["n1:0", "n1:1", "n1"]);
    expect(JSON.stringify(out.blocks)).not.toContain("secret-pg-value");
    expect(elements[2]!.action_id).toBe(ACTION.freeform);
    // Navigation is the footer link, never a button.
    expect(elements.some((e) => e.url)).toBe(false);
    expect((out.blocks.at(-1) as any).elements[0].text).toBe(
      `<${ctx.openUrl}|View in Dispatch> · Reply in thread`
    );
  });

  it("renders agent markdown, but Slack mentions can't ping anyone", () => {
    const out = questionMessage(
      { options: [{ label: "ok" }] },
      {
        ...ctx,
        text: "**Ship?** <!channel> @here <@U123> <#C9> see [docs](https://x.y)\n```\ncode\n```",
      }
    );
    const body = out.blocks.find((b) => b.type === "markdown") as any;
    expect(body.text).toContain("**Ship?**");
    expect(body.text).toContain("[docs](https://x.y)");
    expect(body.text).toContain("```\ncode\n```");
    for (const token of ["<!channel>", "@here", "<@U123>", "<#C9>"])
      expect(JSON.stringify(out.blocks)).not.toContain(token);
    // Our own header line escapes names so they stay text.
    const head = questionMessage(
      { options: [{ label: "ok" }] },
      { ...ctx, agentName: "<!channel> bot" }
    ).blocks[0] as any;
    expect(head.text.text).toContain("&lt;!channel&gt; bot");
    expect(head.text.text).not.toContain("<!channel>");
  });

  it("falls back to the View in Dispatch footer with explicit reasons instead of dropping", () => {
    const out = questionMessage(
      { options: [{ label: "x".repeat(80) }, { label: "fine" }] },
      { ...ctx, text: "q".repeat(9000) }
    );
    expect(out.unsupported).toEqual([
      "the question is 9000 characters (Slack shows 8000)",
      "1 option label is longer than Slack allows",
    ]);
    // Nothing answerable here: no actions block at all, reasons, then footer.
    expect(out.blocks.map((b) => b.type)).toEqual([
      "section",
      "markdown",
      "context",
      "context",
    ]);
    expect((out.blocks[2] as any).elements[0].text).toContain(
      "Answer in Dispatch:"
    );
    expect((out.blocks[3] as any).elements[0].text).toContain(
      `<${ctx.openUrl}|View in Dispatch>`
    );
    const body = out.blocks.find((b) => b.type === "markdown") as any;
    expect(body.text).toHaveLength(MARKDOWN_MAX);
    expect(body.text.endsWith("…")).toBe(true);
  });

  it("keeps parent-handled asks out of Slack answering", () => {
    for (const out of [
      questionMessage(
        { options: [{ label: "Merge" }], parentHandled: true },
        ctx
      ),
    ]) {
      expect(out.unsupported.length).toBeGreaterThan(0);
      expect(actionsOf(out.blocks)).toEqual([]);
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
    expect(actionsOf(out.blocks)).toEqual([]);
    const ok = formMessage(form, ctx);
    expect(ok.unsupported).toEqual([]);
    expect(actionsOf(ok.blocks)[0]).toMatchObject({
      action_id: ACTION.form,
      value: "n1",
    });
    // The form shows its own fields; the message doesn't count them.
    expect(JSON.stringify(ok.blocks)).not.toMatch(/fields?\b.*required/);
  });
});

describe("settledMessage", () => {
  it("removes actions and says only who answered, plus a delivery problem if any", () => {
    const out = settledMessage(ctx, {
      kind: "answered",
      by: "@brad",
      summary: '"Postgres"',
      delivery: "not_delivered",
    });
    expect(out.blocks.some((b) => b.type === "actions")).toBe(false);
    expect(out.blocks.map((b) => b.type)).toEqual([
      "section",
      "markdown",
      "context",
      "context",
    ]);
    const status = out.blocks[2] as any;
    expect(status.block_id).toBe("done:n1");
    // Not delivered is the one delivery state worth showing, as a warning.
    expect(status.elements[0].text).toBe(
      ':warning: @brad answered "Postgres" · the agent hasn\'t received it yet — retry in Dispatch'
    );
    expect((out.blocks[3] as any).elements[0].text).toBe(
      `<${ctx.openUrl}|View in Dispatch>`
    );
    expect(out.text).not.toMatch(/picked up|recorded|in Slack/);
    // Delivered or in flight: just who answered and with what.
    for (const delivery of ["delivered", "sending"] as const) {
      const ok = settledMessage(ctx, {
        kind: "answered",
        by: "@brad",
        summary: '"Postgres"',
        delivery,
      });
      expect((ok.blocks[2] as any).elements[0].text).toBe(
        ':white_check_mark: @brad answered "Postgres"'
      );
    }
    const form = settledMessage(
      ctx,
      {
        kind: "answered",
        by: "@brad",
        delivery: "delivered",
      },
      { title: "Release", fields: [] }
    );
    expect((form.blocks[2] as any).elements[0].text).toBe(
      ":white_check_mark: @brad submitted the form"
    );
  });
});

describe("notifyMessage", () => {
  it("uses the shared layout: who, markdown body, images, then the View in Dispatch footer", () => {
    const image = {
      type: "image",
      slack_file: { id: "F1" },
      alt_text: "shot.png",
    };
    const out = notifyMessage({
      agentName: "builder-7",
      title: "Build is green",
      message: "All **42** tests pass. <!here>",
      openUrl: "http://lan:6767/agents/agt_1",
      images: [image],
    });
    expect(out.blocks.map((b) => b.type)).toEqual([
      "section",
      "markdown",
      "image",
      "context",
    ]);
    expect((out.blocks[0] as any).text.text).toBe("*_builder-7_*");
    expect((out.blocks[1] as any).text).toBe(
      "**Build is green**\n\nAll **42** tests pass. <\u200b!here>"
    );
    expect((out.blocks[3] as any).elements[0].text).toBe(
      "<http://lan:6767/agents/agt_1|View in Dispatch> · Reply in thread"
    );
    expect(out.text).not.toContain("<!here>");
  });
});

describe("markdownBody", () => {
  it("leaves code exactly as written while neutralizing mentions in prose", async () => {
    const { markdownBody } =
      await import("../src/notifications/slack-blocks.js");
    const text =
      "Ping <!here> please.\n```\nfoo(@channel, Array<@Foo>)\n```\nand `@everyone` inline.";
    const out = markdownBody(text) as any;
    expect(out.text).toContain("```\nfoo(@channel, Array<@Foo>)\n```");
    expect(out.text).toContain("`@everyone`");
    expect(out.text).not.toContain("<!here>");
  });
});
