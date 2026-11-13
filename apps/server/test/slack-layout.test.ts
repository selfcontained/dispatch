import { describe, expect, it } from "vitest";
import type { BlockFormData } from "@dispatch/shared";
import {
  ACTION,
  SLACK_LIMITS,
  VIEW_IN_DISPATCH,
  dispatchMessage,
  fallbackText,
  formMessage,
  notifyMessage,
  questionMessage,
  settledMessage,
  type SlackBlock,
} from "../src/notifications/slack-blocks.js";
import { replyMessage } from "../src/notifications/slack-thread-replies.js";

/**
 * One layout for every Dispatch Slack message with a destination:
 * header · body · media · actions · notes · footer(View in Dispatch).
 */
const URL = "http://lan:6767/agents/agt_1?block=b1&task=tsk_9";
const ctx = {
  ref: "r1",
  agentName: "builder-7",
  context: "Task tsk_9",
  text: "Which database should the migration target?",
  openUrl: URL,
};
const image: SlackBlock = {
  type: "image",
  slack_file: { id: "F1" },
  alt_text: "shot.png",
};
const form: BlockFormData = {
  title: "Release details",
  fields: [
    { id: "v", label: "Version", type: "text", required: true },
    { id: "n", label: "Notes", type: "textarea" },
  ],
};
const bigForm: BlockFormData = {
  fields: [
    {
      id: "region",
      label: "Region",
      type: "select",
      options: Array.from({ length: 140 }, (_, i) => ({ label: `r${i}` })),
    },
  ],
};

const variants: Record<string, { text: string; blocks: SlackBlock[] }> = {
  notify: notifyMessage({
    agentName: "builder-7",
    title: "Build is green",
    message: "All **42** tests pass.",
    openUrl: URL,
  }),
  "notify with images": notifyMessage({
    agentName: "builder-7",
    message: "Screens attached.",
    openUrl: URL,
    images: [image, image],
  }),
  "thread reply": replyMessage({
    agentName: "builder-7",
    context: "Task tsk_9",
    text: "Done: timeout is now **30s**.",
    openUrl: URL,
    images: [image],
  }),
  "thread reply (clipped)": replyMessage({
    agentName: "builder-7",
    text: "x".repeat(9000),
    openUrl: URL,
  }),
  "question (delayed)": questionMessage(
    { options: [{ label: "Postgres" }, { label: "SQLite" }] },
    { ...ctx, headline: "unanswered for 5 minutes" }
  ),
  "question (freeform)": questionMessage(
    { options: [{ label: "Postgres" }], allowFreeform: true },
    ctx
  ),
  "question (not answerable here)": questionMessage(
    { options: [{ label: "Merge" }], parentHandled: true },
    ctx
  ),
  form: formMessage(form, ctx),
  "form (not answerable here)": formMessage(bigForm, ctx),
  "question answered": settledMessage(ctx, {
    kind: "answered",
    by: "@brad",
    summary: '"Postgres"',
    delivery: "delivered",
  }),
  "form submitted": settledMessage(
    ctx,
    {
      kind: "answered",
      by: "the owner",
      delivery: "sending",
    },
    form
  ),
  withdrawn: settledMessage(ctx, { kind: "cancelled", reason: "moot" }),
  closed: settledMessage(ctx, { kind: "error", message: "Closed by x." }),
};

const textOf = (b: SlackBlock) =>
  ((b as any).elements ?? [])
    .map((e: any) => e.text)
    .concat((b as any).text ?? [])
    .join(" ");
const RANK: Record<string, number> = {
  markdown: 1,
  image: 2,
  actions: 3,
};

describe("shared Slack layout", () => {
  for (const [name, message] of Object.entries(variants)) {
    describe(name, () => {
      const { blocks } = message;
      it("starts with the header context: who, verb, task — no links", () => {
        const head = blocks[0] as any;
        expect(head.type).toBe("context");
        expect(head.elements[0].text).toMatch(/^\*builder-7\*/);
        expect(head.elements[0].text).not.toContain("<http");
      });
      it("ends with the one View in Dispatch footer, the only navigation", () => {
        const footer = textOf(blocks.at(-1)!);
        expect(footer.startsWith(`<${URL}|${VIEW_IN_DISPATCH}>`)).toBe(true);
        const all = JSON.stringify(blocks);
        expect(all.split(VIEW_IN_DISPATCH)).toHaveLength(2);
        expect(all).not.toContain("Open in Dispatch");
        expect(all).not.toContain(ACTION.open);
        // No network-reachability disclaimer next to the link.
        expect(JSON.stringify(message)).not.toMatch(/private link|VPN/i);
        for (const b of blocks)
          for (const e of (b as any).elements ?? [])
            expect(e.url).toBeUndefined();
      });
      it("keeps the section order header · body · media · actions · notes · footer", () => {
        const ranks = blocks.slice(1, -1).map((b, i, rest) => {
          if (b.type === "context") {
            // Notes sit after any body/media/actions.
            expect(rest.slice(i + 1).every((x) => x.type === "context")).toBe(
              true
            );
            return 4;
          }
          return RANK[b.type as string]!;
        });
        expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
      });
      it("gives the plain-text fallback the same context and destination", () => {
        expect(message.text.startsWith("builder-7")).toBe(true);
        expect(message.text.endsWith(`<${URL}|${VIEW_IN_DISPATCH}>`)).toBe(
          true
        );
        expect(message.text.length).toBeLessThanOrEqual(
          SLACK_LIMITS.sectionText
        );
      });
      it("stays inside Block Kit limits", () => {
        expect(blocks.length).toBeLessThanOrEqual(SLACK_LIMITS.messageBlocks);
        for (const b of blocks)
          if (b.type === "context")
            for (const e of (b as any).elements)
              expect(e.text.length).toBeLessThanOrEqual(
                SLACK_LIMITS.sectionText
              );
      });
    });
  }

  it("keeps genuine actions, distinct from navigation", () => {
    const ids = (m: { blocks: SlackBlock[] }) =>
      m.blocks
        .filter((b) => b.type === "actions")
        .flatMap((b: any) => b.elements.map((e: any) => e.action_id));
    expect(ids(variants["question (freeform)"]!)).toEqual([
      `${ACTION.option}:0`,
      ACTION.freeform,
    ]);
    expect(ids(variants["form"]!)).toEqual([ACTION.form]);
    for (const name of [
      "notify",
      "thread reply",
      "question (not answerable here)",
      "form (not answerable here)",
      "question answered",
      "withdrawn",
    ])
      expect(ids(variants[name]!)).toEqual([]);
  });

  it("keeps the ask's header, body and footer when it settles", () => {
    const pairs: Array<[string, string]> = [
      ["question (freeform)", "question answered"],
      ["form", "form submitted"],
    ];
    for (const [ask, done] of pairs) {
      const a = variants[ask]!.blocks;
      const d = variants[done]!.blocks;
      expect(textOf(d[0]!)).toMatch(/^\*builder-7\* asked.* · Task tsk_9$/);
      expect(d[1]).toEqual(a[1]); // same body (form keeps its title)
      // Same destination; only the reply hint, which needs buttons, goes.
      expect(textOf(d.at(-1)!)).toBe(`<${URL}|${VIEW_IN_DISPATCH}>`);
      expect(textOf(a.at(-1)!).startsWith(textOf(d.at(-1)!))).toBe(true);
    }
    // A stale "unanswered for 5 minutes" headline doesn't survive the answer.
    const settledFromDelayed = settledMessage(
      { ...ctx, headline: "unanswered for 5 minutes" },
      { kind: "cancelled" }
    );
    expect(textOf(settledFromDelayed.blocks[0]!)).not.toContain("unanswered");
  });

  it("never invents a destination", () => {
    const out = dispatchMessage({
      header: { agentName: "builder-7" },
      body: "hi",
      summary: "hi",
    });
    expect(out.blocks.map((b) => b.type)).toEqual(["context", "markdown"]);
    expect(out.text).toBe("builder-7: hi");
    expect(JSON.stringify(out)).not.toContain(VIEW_IN_DISPATCH);
  });

  it("escapes names, context and link targets in our own mrkdwn", () => {
    const evil = "http://lan/a?b=1|<!channel> >x";
    const out = questionMessage(
      { options: [{ label: "ok" }] },
      {
        ...ctx,
        agentName: "<!channel> & bot",
        context: "Task <@U1>",
        openUrl: evil,
      }
    );
    const head = textOf(out.blocks[0]!);
    expect(head).toContain("&lt;!channel&gt; &amp; bot");
    expect(head).toContain("Task &lt;@U1&gt;");
    const footer = textOf(out.blocks.at(-1)!);
    expect(footer).toMatch(
      /^<http:\/\/lan\/a\?b=1%7C%3C!channel%3E%20%3Ex\|View in Dispatch>/
    );
    expect(out.text).not.toContain("<!channel>");
    expect(out.text).not.toContain("<@U1>");
  });

  it("keeps the fallback link whole for long content and long names", () => {
    const out = notifyMessage({
      agentName: "a".repeat(500),
      title: "&".repeat(3000),
      message: "m",
      openUrl: URL,
    });
    expect(out.text.length).toBeLessThanOrEqual(SLACK_LIMITS.sectionText);
    expect(out.text.endsWith(`<${URL}|${VIEW_IN_DISPATCH}>`)).toBe(true);
    // Clipped on an entity boundary, never a broken "&am".
    expect(out.text).toMatch(/(&amp;)+… · </);
    const head = notifyMessage({
      agentName: "&".repeat(1000),
      message: "m",
      openUrl: URL,
    }).blocks[0] as any;
    expect(head.elements[0].text.length).toBeLessThanOrEqual(3000);
    expect(head.elements[0].text).toMatch(/(&amp;)+…$/);
  });

  it("omits the task when there is none, without moving other parts", () => {
    const out = questionMessage(
      { options: [{ label: "ok" }] },
      { ...ctx, context: undefined }
    );
    expect(textOf(out.blocks[0]!)).toBe("*builder-7* asks");
    expect(out.blocks.map((b) => b.type)).toEqual([
      "context",
      "markdown",
      "actions",
      "context",
    ]);
  });

  it("puts the destination in the fallback built on its own", () => {
    expect(
      fallbackText({
        header: { agentName: "b", verb: "asks", parts: ["Task t"] },
        summary: "line one\n\nline two",
        openUrl: URL,
      })
    ).toBe(`b asks · Task t: line one line two · <${URL}|${VIEW_IN_DISPATCH}>`);
  });
});
