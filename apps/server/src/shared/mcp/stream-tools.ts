import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import {
  BLOCK_ATTACHMENTS_MAX,
  BLOCK_FORM_FIELDS_MAX,
  BLOCK_OPTION_LABEL_MAX_CHARS,
  BLOCK_OPTIONS_MAX,
  BLOCK_REVIEW_FINDINGS_MAX,
  BLOCK_TASKS_MAX,
  BLOCK_TEXT_MAX_CHARS,
} from "@dispatch/shared";

import type { StreamService } from "../../chat/service.js";
import { chatUrlSchema } from "../../chat/validation.js";
import { jsonText } from "./response.js";
import { toToolError } from "./tool-error.js";

export type StreamToolsContext = {
  agentId: string;
  streams?: Pick<
    StreamService,
    "post" | "update" | "addReaction" | "removeReaction"
  >;
};

const optionSchema = z.object({
  label: z
    .string()
    .min(1)
    .max(BLOCK_OPTION_LABEL_MAX_CHARS)
    .describe(
      'The button\'s text: a short action ("Ship it", "Use SQLite"). Explain the choices in the post\'s text, not here.'
    ),
  value: z
    .string()
    .min(1)
    .max(2000)
    .optional()
    .describe("Sent back to you when chosen. Defaults to the label."),
});

const questionSchema = z
  .object({
    options: z.array(optionSchema).min(1).max(BLOCK_OPTIONS_MAX),
    allowFreeform: z
      .boolean()
      .optional()
      .describe("Hint that a typed reply is also acceptable."),
  })
  .describe(
    'Ask the user (or the agent in `to`) something with options. The options render as buttons, so keep each label to a short action and put the context in the text; the choice comes back to you as a DISPATCH POST with replyTo set to this block. While it is open you show as Waiting. If you found the answer yourself, close it with update({ id, state: { answer: "<what settled it>" } }). If you no longer need it asked at all, withdraw it instead: update({ id, state: { cancellation: true } }) (or { cancellation: "<short reason>" }).'
  );

const formSchema = z
  .object({
    title: z.string().max(200).optional(),
    fields: z
      .array(
        z.object({
          id: z.string().min(1).max(64),
          label: z.string().min(1).max(200),
          type: z.enum(["text", "textarea", "number", "select", "checkbox"]),
          options: z.array(optionSchema).max(BLOCK_OPTIONS_MAX).optional(),
          required: z.boolean().optional(),
          placeholder: z.string().max(200).optional(),
          value: z.union([z.string(), z.number(), z.boolean()]).optional(),
        })
      )
      .min(1)
      .max(BLOCK_FORM_FIELDS_MAX),
    submitLabel: z.string().max(60).optional(),
  })
  .describe(
    'Collect several values at once. The submission comes back to you as a DISPATCH POST listing each field. While it is open you show as Waiting. If you no longer need it, withdraw it: update({ id, state: { cancellation: true } }) (or { cancellation: "<short reason>" }).'
  );

const linkSchema = z
  .object({
    url: chatUrlSchema,
    title: z.string().max(200).optional(),
  })
  .describe(
    "A link card: a dev server, a PR, a doc. Shows in the stream and the Inbox."
  );

const reviewSchema = z
  .object({
    summary: z.string().min(1).max(4000),
    findings: z
      .array(
        z.object({
          severity: z.enum(["blocker", "major", "minor", "nit"]),
          title: z.string().min(1).max(300),
          body: z.string().min(1).max(BLOCK_TEXT_MAX_CHARS),
          path: z.string().max(1000).optional(),
          line: z.int().positive().optional(),
        })
      )
      .max(BLOCK_REVIEW_FINDINGS_MAX),
  })
  .describe(
    "A structured review of an agent's work: one block, each finding a block of its own with its own thread. Post it with `to` set to the agent whose work you reviewed. Where it stands comes from its findings: resolve each once it is addressed."
  );

const tasksSchema = z
  .object({
    items: z
      .array(
        z.object({
          id: z.string().min(1).max(64),
          text: z.string().min(1).max(500),
        })
      )
      .min(1)
      .max(BLOCK_TASKS_MAX),
  })
  .describe(
    'A checklist. Tick items later with update: { state: { items: { <id>: "done" } } }.'
  );

const attachmentSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("file"),
      path: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Absolute path of a file on your machine to upload and attach (images, pdf, text, code)."
        ),
      fileName: z
        .string()
        .min(1)
        .optional()
        .describe("A file you attached before, by the fileName in its block."),
      fileId: z.int().positive().optional(),
      description: z.string().max(500).optional(),
    })
    .describe(
      "One of path (upload now), fileName or fileId (already uploaded)."
    ),
  z.object({
    type: z.literal("link"),
    url: chatUrlSchema,
    title: z.string().max(200).optional(),
  }),
  z.object({
    type: z.literal("pr"),
    url: chatUrlSchema,
    title: z.string().max(200).optional(),
  }),
  z.object({
    type: z.literal("code"),
    code: z.string().min(1).max(BLOCK_TEXT_MAX_CHARS),
    language: z.string().max(40).optional(),
    path: z
      .string()
      .max(1000)
      .optional()
      .describe("Caption: where the snippet is from."),
  }),
]);

const attachmentsSchema = z
  .array(attachmentSchema)
  .max(BLOCK_ATTACHMENTS_MAX)
  .describe(
    `Up to ${BLOCK_ATTACHMENTS_MAX}. file (path to upload, or fileName/fileId of one already shared), link, pr, or code. Several images go in one post; the stream lays them out together. Posted on your own stream during a turn, they show inside that turn's message, with any text as a short caption.`
  );

const textSchema = z
  .string()
  .max(BLOCK_TEXT_MAX_CHARS)
  .describe(`Markdown body, up to ${BLOCK_TEXT_MAX_CHARS} characters.`);

const POST_DESCRIPTION =
  "Post a block into a stream. Without `to` it goes to your own stream, where the user reads it (a child agent's goes to the thread on its launch card). " +
  "With `to: <agentId>` it is delivered to that agent as a prompt (any agent, any time); the user still sees it in the stream. " +
  "Your ordinary replies already appear in the stream as you write them, so use post for what plain text cannot do: " +
  'a question with options (`question`), a form (`form`), a file (`attachments: [{ type: "file", path }]`), a link (`link`), a review of another agent\'s work (`review`, with `to`), a checklist (`tasks`), ' +
  "or a message to another agent (`to`). `replyTo` threads the block under another (use the id from a DISPATCH POST envelope or a post result). " +
  "`notify: true` also sends the browser/Slack notification. Returns { id, createdAt } (a review also returns its findings' ids); keep the id to update the block later.";

const UPDATE_DESCRIPTION =
  "Revise a block you posted (text, data, attachments, state) or change the state of a block addressed to you " +
  '(resolve a finding you raised, by its id: { state: { status: "fixed" } }, or { status: "dismissed", note }; reopen with { status: "open", note }; tick a task: { state: { items: { <id>: "done" } } }; close your own question: { state: { answer: "<what settled it>" } }). ' +
  'Cancel your own question or form before anyone answers: { state: { cancellation: true } }, or with a short reason: { state: { cancellation: "<reason>" } } (or { cancellation: { reason } }). The ask remains visible, disabled, with a cancellation note. ' +
  "Supply only the fields to change; attachments, when given, replace the whole list. Returns { id, updatedAt }.";

const REACT_DESCRIPTION =
  "Put an emoji reaction on a block someone else posted on your stream (the user's message, another agent's post), by the id from its DISPATCH POST envelope. " +
  "A reaction does not count as an unread message for the user, so anything they need to read still belongs in a post. Pass remove: true to take it off.";

/** `post`, `update`, `react`: the whole stream surface an agent has. */
export function registerStreamTools(
  server: McpServer,
  allowed: ReadonlySet<string>,
  context: StreamToolsContext
): void {
  if (!context.streams) return;
  const streams = context.streams;
  const agentId = context.agentId;

  if (allowed.has("post")) {
    server.registerTool(
      "post",
      {
        description: POST_DESCRIPTION,
        inputSchema: {
          to: z
            .string()
            .min(1)
            .optional()
            .describe("Agent id to deliver to. Omit for your own stream."),
          text: textSchema.optional(),
          replyTo: z.uuid().optional(),
          question: questionSchema.optional(),
          form: formSchema.optional(),
          link: linkSchema.optional(),
          review: reviewSchema.optional(),
          tasks: tasksSchema.optional(),
          attachments: attachmentsSchema.optional(),
          notify: z.boolean().optional(),
        },
      },
      async (args) => {
        try {
          const block = await streams.post(agentId, {
            to: args.to ?? null,
            text: args.text,
            replyTo: args.replyTo ?? null,
            question: args.question ?? null,
            form: args.form ?? null,
            link: args.link ?? null,
            review: args.review ?? null,
            tasks: args.tasks ?? null,
            attachments: args.attachments ?? [],
            notify: args.notify,
          });
          const findings = (block.blocks ?? []).flatMap((shown) =>
            shown.kind === "finding"
              ? [{ id: shown.id, title: shown.data.title }]
              : []
          );
          const result = {
            id: block.id,
            kind: block.kind,
            createdAt: block.createdAt,
            ...(findings.length > 0 ? { findings } : {}),
          };
          return {
            content: [{ type: "text", text: jsonText(result) }],
            structuredContent: result,
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }

  if (allowed.has("update")) {
    server.registerTool(
      "update",
      {
        description: UPDATE_DESCRIPTION,
        inputSchema: {
          id: z
            .uuid()
            .describe("Id returned by post, or from a DISPATCH POST envelope."),
          text: textSchema.optional(),
          data: z
            .record(z.string(), z.unknown())
            .optional()
            .describe(
              "Replacement data for the block's kind (question options, form fields, link, review, tasks)."
            ),
          state: z
            .record(z.string(), z.unknown())
            .optional()
            .describe(
              'A finding: { status: "fixed" | "dismissed" | "open", note? }. Tasks: { items: { <id>: <status> } }.'
            ),
          attachments: attachmentsSchema.optional(),
        },
      },
      async (args) => {
        try {
          const block = await streams.update(agentId, args.id, {
            text: args.text,
            data: args.data,
            state: args.state,
            attachments: args.attachments,
          });
          const result = { id: block.id, updatedAt: block.updatedAt };
          return {
            content: [{ type: "text", text: jsonText(result) }],
            structuredContent: result,
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }

  if (allowed.has("react")) {
    server.registerTool(
      "react",
      {
        description: REACT_DESCRIPTION,
        inputSchema: {
          id: z.uuid().describe("Block id from its DISPATCH POST envelope."),
          emoji: z
            .string()
            .min(1)
            .max(32)
            .describe("A single emoji, such as 👍."),
          remove: z
            .boolean()
            .optional()
            .describe("True to take your reaction back off."),
        },
      },
      async (args) => {
        try {
          const author = { kind: "agent" as const, agentId };
          const response = args.remove
            ? await streams.removeReaction(agentId, args.id, args.emoji, author)
            : await streams.addReaction(agentId, args.id, args.emoji, author);
          return {
            content: [{ type: "text", text: jsonText(response) }],
            structuredContent: response,
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }
}
