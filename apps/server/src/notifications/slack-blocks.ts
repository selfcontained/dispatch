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
 * represent faithfully is listed in `unsupported` and the caller shows an
 * Open-in-Dispatch fallback instead of a partial answer UI.
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
export function markdownBody(text: string, max = MARKDOWN_MAX): SlackBlock {
  return { type: "markdown", text: clip(neutralizeMentions(text), max) };
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
/** One small line naming who and where, e.g. "*builder-7* asks · Task …". */
export function headerLine(input: {
  agentName: string;
  verb?: string;
  parts?: Array<string | undefined>;
  openUrl?: string;
}): SlackBlock {
  const who = `*${mrkdwnText(input.agentName)}*${input.verb ? ` ${mrkdwnText(input.verb)}` : ""}`;
  const text = [
    who,
    ...(input.parts ?? []).filter(Boolean).map((p) => mrkdwnText(p!)),
    ...(input.openUrl ? [mrkdwnLink(input.openUrl, "Open in Dispatch")] : []),
  ].join(" · ");
  return { type: "context", elements: [{ type: "mrkdwn", text }] };
}
/** Muted footer: the link is private, and how to answer. */
export function footerLine(agentName?: string): SlackBlock {
  const text = [
    "Private link: opens on your LAN or VPN",
    agentName
      ? `Reply in this thread to message *${mrkdwnText(agentName)}*`
      : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  return { type: "context", elements: [{ type: "mrkdwn", text }] };
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
  return {
    text: neutralizeMentions(
      clip(`${input.agentName}: ${input.title ?? input.message}`, 2900)
    ),
    blocks: [
      headerLine({ agentName: input.agentName }),
      markdownBody(body),
      ...(input.images ?? []),
      { type: "actions", elements: [openButton(input.openUrl, true)] },
      footerLine(input.agentName),
    ],
  };
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

function header(ctx: AskContext, verb: string, openUrl?: string): SlackBlock[] {
  const blocks: SlackBlock[] = [
    headerLine({
      agentName: ctx.agentName,
      verb,
      parts: [ctx.headline, ctx.context],
      openUrl,
    }),
  ];
  if (ctx.text.trim()) blocks.push(markdownBody(ctx.text));
  return blocks;
}

export function openButton(url: string, primary = false): SlackBlock {
  return {
    type: "button",
    action_id: ACTION.open,
    text: plain("Open in Dispatch", SLACK_LIMITS.buttonText),
    url,
    ...(primary ? { style: "primary" } : {}),
  };
}

function fallback(reasons: string[]): SlackBlock {
  return {
    type: "context",
    elements: [
      plain(
        `Answer in Dispatch: ${reasons.join("; ")}.`,
        SLACK_LIMITS.sectionText
      ),
    ],
  };
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
  if (question.options.length + extra + 1 > SLACK_LIMITS.actionsElements)
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
  elements.push(openButton(ctx.openUrl));
  const blocks = [
    ...header(ctx, "asks"),
    { type: "actions", block_id: `ask:${ctx.ref}`, elements },
  ];
  if (unsupported.length) blocks.push(fallback(unsupported));
  else if (question.allowFreeform)
    blocks.push({
      type: "context",
      elements: [
        plain(
          "Or reply in this thread to answer in your own words.",
          SLACK_LIMITS.sectionText
        ),
      ],
    });
  blocks.push(footerLine());
  return {
    text: clip(`${ctx.agentName} asks: ${ctx.text}`, SLACK_LIMITS.sectionText),
    blocks,
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
  elements.push(openButton(ctx.openUrl));
  const blocks: SlackBlock[] = [
    ...header(
      {
        ...ctx,
        text: [title ? `**${title}**` : undefined, ctx.text]
          .filter(Boolean)
          .join("\n"),
      },
      `asks you to fill in a form (${summary})`
    ),
    { type: "actions", block_id: `ask:${ctx.ref}`, elements },
  ];
  if (unsupported.length) blocks.push(fallback(unsupported));
  blocks.push(footerLine());
  return {
    text: clip(
      `${ctx.agentName} asks you to fill in ${title ? `"${title}"` : "a form"}`,
      SLACK_LIMITS.sectionText
    ),
    blocks,
    unsupported,
  };
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
      via: "slack" | "dispatch";
      summary: string;
      delivery: DeliveryShown;
    }
  | { kind: "cancelled"; reason?: string }
  | { kind: "error"; message: string };

/** The parent message after the ask settles: no actions remain. */
export function settledMessage(ctx: AskContext, outcome: Outcome): Adapted {
  const line =
    outcome.kind === "answered"
      ? `Answered by ${outcome.by}${outcome.via === "slack" ? " in Slack" : " in Dispatch"}: ${outcome.summary} · recorded · ${deliveryPhrase(
          "the agent",
          outcome.delivery
        )}`
      : outcome.kind === "cancelled"
        ? `Withdrawn${outcome.reason ? `: ${outcome.reason}` : ""}`
        : outcome.message;
  const mark =
    outcome.kind === "answered"
      ? ":white_check_mark:"
      : outcome.kind === "cancelled"
        ? ":heavy_minus_sign:"
        : ":warning:";
  return {
    text: clip(line, SLACK_LIMITS.sectionText),
    blocks: [
      ...header(ctx, "asked"),
      {
        type: "context",
        block_id: `done:${ctx.ref}`,
        elements: [
          {
            type: "mrkdwn",
            text: `${mark} ${mrkdwnText(clip(line, 2900))} · ${mrkdwnLink(ctx.openUrl, "Open in Dispatch")}`,
          },
        ],
      },
    ],
    unsupported: [],
  };
}
