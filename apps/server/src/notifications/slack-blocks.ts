import type {
  BlockFormData,
  BlockFormField,
  BlockQuestionData,
} from "@dispatch/shared";

/**
 * Bounded adapters between Dispatch question/form blocks and Slack Block Kit.
 *
 * The stored Dispatch block is the source of truth. Slack only ever sees
 * opaque identifiers (`<ref>:<index>`) for options; the write path maps them
 * back onto the stored original and re-validates there. Anything Slack can't
 * represent faithfully is listed in `unsupported`: the message then says
 * why and points at its View in Dispatch footer instead of a partial answer UI.
 *
 * Limits verified against docs.slack.dev (2026-11):
 *  - section text 3000, button text 75, option text 75 / value 150,
 *  - actions block 25 elements, message 50 blocks, modal 100 blocks,
 *  - modal title/submit/close 24, private_metadata 3000,
 *  - input label/hint 2000, plain_text_input max_length 3000,
 *  - static_select 100 options, placeholder 150,
 *  - number_input is modal-only.
 */
export const SLACK_LIMITS = {
  sectionText: 3000,
  buttonText: 75,
  optionText: 75,
  optionValue: 150,
  actionsElements: 25,
  messageBlocks: 50,
  modalBlocks: 100,
  modalTitle: 24,
  modalButton: 24,
  privateMetadata: 3000,
  inputLabel: 2000,
  plainTextInput: 3000,
  selectOptions: 100,
  placeholder: 150,
} as const;

export const ACTION = {
  option: "dispatch_option",
  freeform: "dispatch_freeform",
  form: "dispatch_form",
  /** Legacy navigation button, still acked for messages already in Slack. */
  open: "dispatch_open",
} as const;
export const FREEFORM_CALLBACK = "dispatch_freeform_modal";
export const FORM_CALLBACK = "dispatch_form_modal";

type Text = { type: "plain_text"; text: string; emoji?: boolean };
export type SlackBlock = Record<string, unknown>;

/** Plain text only: agent content never reaches Slack as mrkdwn, so no @channel/link injection. */
export function plain(text: string, max: number): Text {
  return { type: "plain_text", text: clip(text, max), emoji: false };
}

/**
 * Agent-written text, rendered with Slack's `markdown` block (bold, lists,
 * code, real links). Slack's own control tokens can't ping or mislead
 * anyone: `<!channel>`, `<@U…>`, `<#C…>` and bare @channel/@here/@everyone
 * are broken with a zero-width space, so they show as text.
 */
export const MARKDOWN_MAX = 8000;
export function neutralizeMentions(text: string) {
  return text
    .replace(/<([!@#])/g, "<\u200b$1")
    .replace(/@(channel|here|everyone)\b/gi, "@\u200b$1");
}
/**
 * Neutralize outside code only: Slack doesn't parse mention tokens inside
 * fenced or inline code, and code should copy out exactly as written.
 */
export function neutralizeOutsideCode(text: string) {
  return text
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((part, i) => (i % 2 ? part : neutralizeMentions(part)))
    .join("");
}
export function markdownBody(text: string, max = MARKDOWN_MAX): SlackBlock {
  return { type: "markdown", text: clip(neutralizeOutsideCode(text), max) };
}
/** Our own context lines are mrkdwn: escape names/titles so they stay text. */
export function mrkdwnText(text: string) {
  return neutralizeMentions(
    text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  );
}
export function mrkdwnLink(url: string, label: string) {
  return `<${url.replace(/[<>|\s]/g, encodeURIComponent)}|${mrkdwnText(label)}>`;
}
/**
 * ── The shared message layout ───────────────────────────────
 *
 * Every Dispatch-generated Slack message that has a Dispatch destination is
 * built from the same parts, always in this order; optional parts are left
 * out without moving the others:
 *
 *   1. header   section  Question from *_agent_* · headline · Task tsk_…   (no links)
 *   2. body     markdown  agent-written title/text
 *   3. media    image blocks
 *   4. actions  genuine Slack actions only (answer, Fill in form…)
 *   5. notes    context   status or why it can't be answered here
 *   6. footer   context   <url|View in Dispatch> · reply hint
 *
 * Navigation lives only in the footer, as the one "View in Dispatch" link;
 * there is never a navigation button. No URL → no link (never invented).
 */
export const VIEW_IN_DISPATCH = "View in Dispatch";

type Header = {
  agentName: string;
  /** What this is, e.g. "Question": "Question from <agent>"; plain "From <agent>" otherwise. */
  kind?: "Question" | "Form" | "Reply";
  parts?: Array<string | undefined>;
};
const lead = (header: Header) =>
  `${header.kind ? `${header.kind} from` : "From"}`;

/**
 * The line that leads the message: who and where, e.g. "Question from *_builder-7_* ·
 * Task …". Full-strength text (a section), not a muted context line.
 */
export function headerLine(input: Header): SlackBlock {
  // The agent's name is Dispatch's to add, set off in bold italics.
  const who = `${lead(input)} *_${mrkdwnText(input.agentName)}_*`;
  const text = [
    who,
    ...(input.parts ?? []).filter(Boolean).map((p) => mrkdwnText(p!)),
  ].join(" · ");
  return {
    type: "section",
    text: { type: "mrkdwn", text: clipEscaped(text, SLACK_LIMITS.sectionText) },
  };
}

/** A muted status line between the actions and the footer. */
export function noteLine(text: string, blockId?: string): SlackBlock {
  return {
    type: "context",
    ...(blockId ? { block_id: blockId } : {}),
    elements: [
      { type: "mrkdwn", text: clipEscaped(text, SLACK_LIMITS.sectionText) },
    ],
  };
}

/**
 * The footer every Dispatch message ends with: the "View in Dispatch" link
 * first, then how to reply (when it applies).
 * Empty when there is neither a destination nor a hint.
 */
export function footerLine(input: {
  openUrl?: string;
  hint?: string;
}): SlackBlock[] {
  const parts = [
    ...(input.openUrl ? [mrkdwnLink(input.openUrl, VIEW_IN_DISPATCH)] : []),
    ...(input.hint ? [input.hint] : []),
  ];
  if (!parts.length) return [];
  return [
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: parts.join(" · ") }],
    },
  ];
}

/** Escape for mrkdwn, then clip without leaving a broken `&amp;` entity. */
function clipEscaped(escaped: string, max: number) {
  if (escaped.length <= max) return escaped;
  return `${escaped.slice(0, max - 1).replace(/&[a-z]{0,4}$/, "")}…`;
}

/**
 * The top-level `text`: what notifications, screen readers and clients
 * without Block Kit show. Same context as the header, a one-line summary,
 * and the same destination as the footer. Escaped like our own mrkdwn.
 */
export function fallbackText(input: {
  header: Header;
  summary: string;
  openUrl?: string;
}) {
  const { header } = input;
  const who = [
    `${lead(header)} ${header.agentName}`,
    ...(header.parts ?? []).filter(Boolean),
  ].join(" · ");
  const summary = input.summary.replace(/\s+/g, " ").trim();
  const link = input.openUrl
    ? ` · ${mrkdwnLink(input.openUrl, VIEW_IN_DISPATCH)}`
    : "";
  // Slack keeps 3000 characters of `text`; the link must survive the cut.
  return `${clipEscaped(
    mrkdwnText(summary ? `${who}: ${summary}` : who),
    Math.max(200, SLACK_LIMITS.sectionText - 100 - link.length)
  )}${link}`;
}

/** Assemble the shared layout. See the comment above for the order. */
export function dispatchMessage(input: {
  header: Header;
  body?: string;
  bodyMax?: number;
  media?: SlackBlock[];
  actions?: { blockId?: string; elements: SlackBlock[] };
  notes?: SlackBlock[];
  openUrl?: string;
  hint?: string;
  summary: string;
}): { text: string; blocks: SlackBlock[] } {
  return {
    text: fallbackText({
      header: input.header,
      summary: input.summary,
      openUrl: input.openUrl,
    }),
    blocks: [
      headerLine(input.header),
      ...(input.body?.trim() ? [markdownBody(input.body, input.bodyMax)] : []),
      ...(input.media ?? []),
      ...(input.actions?.elements.length
        ? [
            {
              type: "actions",
              ...(input.actions.blockId
                ? { block_id: input.actions.blockId }
                : {}),
              elements: input.actions.elements,
            },
          ]
        : []),
      ...(input.notes ?? []),
      ...footerLine({ openUrl: input.openUrl, hint: input.hint }),
    ],
  };
}

/** A Dispatch notification in the shared layout. */
export function notifyMessage(input: {
  agentName: string;
  title?: string;
  message: string;
  openUrl: string;
  images?: SlackBlock[];
}): { text: string; blocks: SlackBlock[] } {
  const body = input.title
    ? `**${input.title}**\n\n${input.message}`
    : input.message;
  return dispatchMessage({
    header: { agentName: input.agentName },
    body,
    media: input.images,
    openUrl: input.openUrl,
    hint: `Reply in this thread to message *${mrkdwnText(input.agentName)}*`,
    summary: input.title ?? input.message,
  });
}

export function clip(text: string, max: number) {
  const value = text.trim() || " ";
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

export type AskContext = {
  /** Opaque, server-minted reference for the Slack message row. */
  ref: string;
  agentName: string;
  /** "Project · Task: …", optional. */
  context?: string;
  text: string;
  openUrl: string;
  /** Prefix line, e.g. "Unanswered for 5 minutes". */
  headline?: string;
};

export type Adapted = {
  text: string;
  blocks: SlackBlock[];
  /** Human-readable reasons the ask is not answerable in Slack. Empty = answerable. */
  unsupported: string[];
};

/** An ask's header: who asks, how long it waited, and which task. */
function askHeader(
  ctx: AskContext,
  kind: "Question" | "Form",
  detail?: string
): Header {
  return {
    agentName: ctx.agentName,
    kind,
    parts: [detail, ctx.headline, ctx.context],
  };
}

/** Why it can't be answered here: the footer link is where to answer. */
function fallback(reasons: string[]): SlackBlock {
  return noteLine(mrkdwnText(`Answer in Dispatch: ${reasons.join("; ")}.`));
}

function textReasons(text: string) {
  return text.length > MARKDOWN_MAX
    ? [
        `the question is ${text.length} characters (Slack shows ${MARKDOWN_MAX})`,
      ]
    : [];
}

export function questionMessage(
  question: BlockQuestionData,
  ctx: AskContext
): Adapted {
  const unsupported = [...textReasons(ctx.text)];
  if (question.parentHandled) unsupported.push("handled by the parent agent");
  const tooLong = question.options.filter(
    (o) => o.label.length > SLACK_LIMITS.buttonText
  ).length;
  if (tooLong)
    unsupported.push(
      `${tooLong} option label${tooLong === 1 ? " is" : "s are"} longer than Slack allows`
    );
  const extra = question.allowFreeform ? 1 : 0;
  if (question.options.length + extra > SLACK_LIMITS.actionsElements)
    unsupported.push(
      `${question.options.length} options exceed Slack's button limit`
    );

  const elements: SlackBlock[] = [];
  if (!unsupported.length) {
    question.options.forEach((option, index) =>
      elements.push({
        type: "button",
        action_id: `${ACTION.option}:${index}`,
        text: plain(option.label, SLACK_LIMITS.buttonText),
        value: `${ctx.ref}:${index}`,
      })
    );
    if (question.allowFreeform)
      elements.push({
        type: "button",
        action_id: ACTION.freeform,
        text: plain("Answer in text…", SLACK_LIMITS.buttonText),
        value: ctx.ref,
      });
  }
  return {
    ...dispatchMessage({
      header: askHeader(ctx, "Question"),
      body: ctx.text,
      actions: { blockId: `ask:${ctx.ref}`, elements },
      notes: unsupported.length ? [fallback(unsupported)] : [],
      openUrl: ctx.openUrl,
      hint:
        !unsupported.length && question.allowFreeform
          ? "Or reply in this thread to answer in your own words"
          : undefined,
      summary: ctx.text,
    }),
    unsupported,
  };
}

/** Why a form can't be shown as a Slack modal; empty when it can. */
export function formUnsupported(form: BlockFormData): string[] {
  const reasons: string[] = [];
  // Each field is one input block; select fields add an "Other" input.
  const blocks = form.fields.reduce(
    (n, f) => n + (f.type === "select" ? 2 : 1),
    0
  );
  if (blocks > SLACK_LIMITS.modalBlocks)
    reasons.push(`${form.fields.length} fields exceed Slack's modal limit`);
  for (const field of form.fields) {
    if (
      !["text", "textarea", "number", "select", "checkbox"].includes(field.type)
    )
      reasons.push(`field "${field.label}" has an unsupported type`);
    if (field.label.length > SLACK_LIMITS.inputLabel)
      reasons.push(`field "${clip(field.label, 40)}" label is too long`);
    if (field.type === "select") {
      const options = field.options ?? [];
      if (!options.length)
        reasons.push(`field "${field.label}" has no options`);
      if (options.length > SLACK_LIMITS.selectOptions)
        reasons.push(`field "${field.label}" has ${options.length} options`);
      if (options.some((o) => o.label.length > SLACK_LIMITS.optionText))
        reasons.push(`field "${field.label}" has options too long for Slack`);
    }
  }
  return reasons;
}

export function formMessage(form: BlockFormData, ctx: AskContext): Adapted {
  const unsupported = [...textReasons(ctx.text), ...formUnsupported(form)];
  if (form.parentHandled) unsupported.push("handled by the parent agent");
  const title = form.title?.trim();
  const required = form.fields.filter((f) => f.required).length;
  const summary = `${form.fields.length} field${form.fields.length === 1 ? "" : "s"}${required ? `, ${required} required` : ""}`;
  const elements: SlackBlock[] = [];
  if (!unsupported.length)
    elements.push({
      type: "button",
      action_id: ACTION.form,
      text: plain("Fill in form…", SLACK_LIMITS.buttonText),
      value: ctx.ref,
    });
  return {
    ...dispatchMessage({
      header: askHeader(ctx, "Form", summary),
      body: formBody(title, ctx.text),
      actions: { blockId: `ask:${ctx.ref}`, elements },
      notes: unsupported.length ? [fallback(unsupported)] : [],
      openUrl: ctx.openUrl,
      summary: title ? `"${title}"` : ctx.text,
    }),
    unsupported,
  };
}

/** A form's title and text, as one markdown body (shared with settled updates). */
export function formBody(title: string | undefined, text: string) {
  return [title ? `**${title}**` : undefined, text].filter(Boolean).join("\n");
}

export function freeformModal(ref: string, questionText: string) {
  return {
    type: "modal",
    callback_id: FREEFORM_CALLBACK,
    private_metadata: ref,
    title: plain("Answer", SLACK_LIMITS.modalTitle),
    submit: plain("Send answer", SLACK_LIMITS.modalButton),
    close: plain("Cancel", SLACK_LIMITS.modalButton),
    blocks: [
      { type: "section", text: plain(questionText, SLACK_LIMITS.sectionText) },
      {
        type: "input",
        block_id: "answer",
        label: plain("Your answer", SLACK_LIMITS.inputLabel),
        element: {
          type: "plain_text_input",
          action_id: "value",
          multiline: true,
          max_length: SLACK_LIMITS.plainTextInput,
        },
      },
    ],
  };
}

const OTHER = "__other__";

function fieldBlocks(field: BlockFormField, index: number): SlackBlock[] {
  const base = {
    type: "input",
    block_id: `f${index}`,
    label: plain(field.label, SLACK_LIMITS.inputLabel),
    // Checkbox "required" in Dispatch means "answer present", which an
    // unchecked box satisfies (false); Slack would demand a tick instead.
    optional: field.type === "checkbox" || !field.required,
  };
  const placeholder = field.placeholder
    ? { placeholder: plain(field.placeholder, SLACK_LIMITS.placeholder) }
    : {};
  switch (field.type) {
    case "text":
    case "textarea":
      return [
        {
          ...base,
          element: {
            type: "plain_text_input",
            action_id: "value",
            multiline: field.type === "textarea",
            max_length: SLACK_LIMITS.plainTextInput,
            ...placeholder,
            ...(typeof field.value === "string" && field.value
              ? {
                  initial_value: field.value.slice(
                    0,
                    SLACK_LIMITS.plainTextInput
                  ),
                }
              : {}),
          },
        },
      ];
    case "number":
      return [
        {
          ...base,
          element: {
            type: "number_input",
            action_id: "value",
            is_decimal_allowed: true,
            ...placeholder,
            ...(field.value !== undefined &&
            field.value !== "" &&
            Number.isFinite(Number(field.value))
              ? { initial_value: String(Number(field.value)) }
              : {}),
          },
        },
      ];
    case "checkbox":
      return [
        {
          ...base,
          element: {
            type: "checkboxes",
            action_id: "value",
            options: [
              { text: plain("Yes", SLACK_LIMITS.optionText), value: "on" },
            ],
            ...(field.value === true
              ? {
                  initial_options: [
                    {
                      text: plain("Yes", SLACK_LIMITS.optionText),
                      value: "on",
                    },
                  ],
                }
              : {}),
          },
        },
      ];
    case "select": {
      const options = (field.options ?? []).map((o, i) => ({
        text: plain(o.label, SLACK_LIMITS.optionText),
        value: String(i),
      }));
      options.push({
        text: plain("Other…", SLACK_LIMITS.optionText),
        value: OTHER,
      });
      const initialIndex = (field.options ?? []).findIndex(
        (o) => field.value !== undefined && (o.value ?? o.label) === field.value
      );
      return [
        {
          ...base,
          element: {
            type: "static_select",
            action_id: "value",
            options,
            ...placeholder,
            ...(initialIndex >= 0
              ? { initial_option: options[initialIndex] }
              : {}),
          },
        },
        {
          type: "input",
          block_id: `f${index}_other`,
          optional: true,
          label: plain(
            `${clip(field.label, 1900)} — other`,
            SLACK_LIMITS.inputLabel
          ),
          hint: plain(
            "Used only when Other… is selected.",
            SLACK_LIMITS.inputLabel
          ),
          element: {
            type: "plain_text_input",
            action_id: "value",
            max_length: SLACK_LIMITS.plainTextInput,
          },
        },
      ];
    }
  }
}

export function formModal(form: BlockFormData, ref: string, context: string) {
  if (formUnsupported(form).length) return null;
  return {
    type: "modal",
    callback_id: FORM_CALLBACK,
    private_metadata: ref,
    title: plain(form.title || "Dispatch form", SLACK_LIMITS.modalTitle),
    submit: plain(form.submitLabel || "Submit", SLACK_LIMITS.modalButton),
    close: plain("Cancel", SLACK_LIMITS.modalButton),
    blocks: [
      {
        type: "context",
        elements: [plain(context, SLACK_LIMITS.sectionText)],
      },
      ...form.fields.flatMap(fieldBlocks),
    ],
  };
}

type ViewState = Record<string, Record<string, Record<string, unknown>>>;

/**
 * Map a Slack view_submission state back onto the stored form. Returns
 * Slack-style `errors` keyed by block_id when invalid, so the modal shows
 * them inline; the server write path re-validates regardless.
 */
export function parseFormSubmission(
  form: BlockFormData,
  state: ViewState
):
  | { values: Record<string, string | number | boolean> }
  | { errors: Record<string, string> } {
  const values: Record<string, string | number | boolean> = {};
  const errors: Record<string, string> = {};
  form.fields.forEach((field, index) => {
    const key = `f${index}`;
    const element = state[key]?.value as Record<string, any> | undefined;
    switch (field.type) {
      case "text":
      case "textarea": {
        const v = typeof element?.value === "string" ? element.value : "";
        if (v.trim()) values[field.id] = v;
        break;
      }
      case "number": {
        const raw =
          typeof element?.value === "string" ? element.value.trim() : "";
        if (!raw) break;
        const n = Number(raw);
        if (!Number.isFinite(n)) errors[key] = "Enter a number.";
        else values[field.id] = n;
        break;
      }
      case "checkbox":
        values[field.id] = Array.isArray(element?.selected_options)
          ? element.selected_options.some((o: any) => o?.value === "on")
          : false;
        break;
      case "select": {
        const selected = element?.selected_option?.value;
        if (selected === undefined || selected === null) break;
        if (selected === OTHER) {
          const other = state[`${key}_other`]?.value as
            | Record<string, any>
            | undefined;
          const text =
            typeof other?.value === "string" ? other.value.trim() : "";
          if (!text) errors[`${key}_other`] = "Type a value for Other.";
          else values[field.id] = text;
          break;
        }
        const option = (field.options ?? [])[Number(selected)];
        if (!/^\d+$/.test(String(selected)) || !option)
          errors[key] = "Choose one of the listed options.";
        else values[field.id] = option.value ?? option.label;
        break;
      }
    }
    if (
      field.required &&
      values[field.id] === undefined &&
      !errors[key] &&
      !errors[`${key}_other`]
    )
      errors[key] = "Required.";
  });
  return Object.keys(errors).length ? { errors } : { values };
}

/** Mirrors the reply block's `delivered`: true, null (in flight), false. */
export type DeliveryShown = "delivered" | "sending" | "not_delivered";

export function deliveryPhrase(name: string, delivery: DeliveryShown) {
  return delivery === "delivered"
    ? `delivered to ${name}`
    : delivery === "sending"
      ? `sending to ${name} — delivery status is in Dispatch`
      : `not delivered to ${name} yet — open Dispatch to retry`;
}

export type Outcome =
  | {
      kind: "answered";
      by: string;
      /** The chosen answer (questions); forms say only that they were submitted. */
      summary?: string;
      delivery: DeliveryShown;
    }
  | { kind: "cancelled"; reason?: string }
  | { kind: "error"; message: string };

/**
 * The parent message after the ask settles: the same header, body and
 * footer as the ask, its actions replaced by one outcome line.
 */
export function settledMessage(
  ctx: AskContext,
  outcome: Outcome,
  form?: BlockFormData
): Adapted {
  // Only what the reader acts on: who answered and with what, and a
  // delivery problem when there is one. Routine progress stays in Dispatch.
  const undelivered =
    outcome.kind === "answered" && outcome.delivery === "not_delivered";
  const line =
    outcome.kind === "answered"
      ? `${outcome.by} ${form ? "submitted the form" : `answered${outcome.summary ? ` ${outcome.summary}` : ""}`}${
          undelivered
            ? " · the agent hasn't received it yet — retry in Dispatch"
            : ""
        }`
      : outcome.kind === "cancelled"
        ? `Withdrawn${outcome.reason ? `: ${outcome.reason}` : ""}`
        : outcome.message;
  const mark =
    outcome.kind === "answered" && !undelivered
      ? ":white_check_mark:"
      : outcome.kind === "cancelled"
        ? ":heavy_minus_sign:"
        : ":warning:";
  const title = form?.title?.trim();
  return {
    ...dispatchMessage({
      header: askHeader(
        { ...ctx, headline: undefined },
        form ? "Form" : "Question"
      ),
      body: form ? formBody(title, ctx.text) : ctx.text,
      notes: [noteLine(`${mark} ${mrkdwnText(line)}`, `done:${ctx.ref}`)],
      openUrl: ctx.openUrl,
      summary: line,
    }),
    unsupported: [],
  };
}
