import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import {
  CHAT_ATTACHMENTS_MAX,
  CHAT_MESSAGE_MAX_CHARS,
  CHAT_QUESTION_OPTIONS_MAX,
} from "@dispatch/shared";

import type { ChatService } from "../../chat/service.js";
import { jsonText } from "./response.js";
import { toToolError } from "./tool-error.js";
import { chatUrlSchema } from "../../chat/validation.js";

export type ChatToolsContext = {
  agentId: string;
  chat?: Pick<ChatService, "post" | "update">;
  /**
   * The chat-surface flag (`chat_surface_enabled`). The tool is registered
   * either way — only its description changes, from describing an optional
   * tab to stating that Chat is where the user actually is. See
   * `CHAT_POST_LEAD_SURFACE_ON`.
   */
  chatSurface?: boolean;
};

const chatKindSchema = z.enum(["reply", "update", "question", "summary"]);

const chatQuestionSchema = z
  .object({
    options: z
      .array(
        z.object({
          label: z.string().min(1).max(200),
          value: z
            .string()
            .min(1)
            .max(2000)
            .optional()
            .describe("Sent back to you when chosen. Defaults to the label."),
        })
      )
      .min(1)
      .max(CHAT_QUESTION_OPTIONS_MAX),
    allowFreeform: z
      .boolean()
      .optional()
      .describe("Hint that a typed reply is also acceptable."),
  })
  .describe(
    'Required when kind is "question", rejected otherwise. The options render as buttons; the user\'s choice comes back to you as a Chat message with replyTo set to this message.'
  );

const chatAttachmentSchema = z.discriminatedUnion("type", [
  z
    .strictObject({
      type: z.literal("file"),
      fileName: z
        .string()
        .min(1)
        .max(255)
        .optional()
        .describe(
          "The stored fileName returned by dispatch_share_file. Local paths are not accepted; share the file first."
        ),
      mediaId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Alternative to fileName: the media row id. Supply one or the other, not both."
        ),
    })
    .refine((file) => Boolean(file.fileName) !== (file.mediaId !== undefined), {
      message:
        "file attachments take exactly one of fileName (from dispatch_share_file) or mediaId.",
    }),
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
    code: z.string().min(1).max(CHAT_MESSAGE_MAX_CHARS),
    language: z.string().max(40).optional(),
    path: z
      .string()
      .max(1000)
      .optional()
      .describe("Caption, e.g. the file the snippet is from."),
  }),
  z.object({
    type: z.literal("pin"),
    pinId: z.string().min(1).describe("Id of one of your own pins."),
  }),
]);

const attachmentsSchema = z
  .array(chatAttachmentSchema)
  .max(CHAT_ATTACHMENTS_MAX)
  .describe(
    `Up to ${CHAT_ATTACHMENTS_MAX}. file (fileName returned by dispatch_share_file), link, pr, code (with optional language and path caption), or pin (one of your pin ids).`
  );

const textSchema = z
  .string()
  .min(1)
  .max(CHAT_MESSAGE_MAX_CHARS)
  .describe(`Markdown body, up to ${CHAT_MESSAGE_MAX_CHARS} characters.`);

/**
 * How `dispatch_chat_post` opens with the chat surface off — or unknown, as
 * on the job route, where the launch turn never carries a Chat envelope. The
 * tool is registered for every agent regardless of the flag, so this wording
 * stays capability-neutral: it describes the mechanics and leaves the
 * question of where the user is reading to the launch guidance.
 */
const CHAT_POST_LEAD_NEUTRAL =
  "Post a message to the optional Chat tab of this session — a native chat view the user may have enabled alongside the terminal (Console). " +
  "Whether the user is reading Chat is set by the Dispatch startup rules; this tool only describes the mechanics. ";

/**
 * How it opens with `chat_surface_enabled` on. `CHAT_SURFACE_GUIDANCE_RULE`
 * says the same thing at launch, and this deliberately restates it, because
 * the two reach the agent very differently:
 *
 * - Launch guidance rides `--append-system-prompt` for `claude`, but for
 *   `codex`, `cursor` and `opencode` it is folded into the startup user
 *   message, which recedes as the session grows.
 * - A tool description is re-read at every tool-selection decision, for
 *   every agent type, however long the session has run.
 *
 * So this is the one placement that survives a long session on every CLI —
 * which is exactly when an agent starts answering into Console instead.
 */
const CHAT_POST_LEAD_SURFACE_ON =
  "Post a message to the Chat tab — where the user is reading this session. " +
  "They are not watching the terminal (Console): a reply written only there never reaches them. " +
  "Send every user-facing reply and question with this tool, and do not end a turn without one. ";

/** The half that never varies: envelope, kinds, text, attachments, editing. */
const CHAT_POST_MECHANICS =
  "Messages the user sends from Chat arrive in your session wrapped in a DISPATCH CHAT envelope carrying an id; set replyTo to that id when answering one. " +
  'kind: "reply" (default) for a normal message, "update" for a lightweight progress note, "summary" for a wrap-up card, ' +
  '"question" to request a decision — supply question.options (rendered as buttons, up to ' +
  `${CHAT_QUESTION_OPTIONS_MAX}) for a finite choice, and allowFreeform when a typed answer also works; the choice comes back as a user message with replyTo set to the question. ` +
  `text is markdown (≤ ${CHAT_MESSAGE_MAX_CHARS} chars). attachments (≤ ${CHAT_ATTACHMENTS_MAX}): ` +
  '{ type: "file", fileName } for a file already shared via dispatch_share_file (use the fileName it returned), { type: "link" | "pr", url, title? }, ' +
  '{ type: "code", code, language?, path? }, or { type: "pin", pinId }. Returns { id, createdAt }; use the id with dispatch_chat_update to revise the message later. ' +
  'An "update" post edited in place as work progresses is the durable form of progress — one message that ends up describing the result, not a trail of stale notes.';

export function buildChatPostDescription(chatSurface: boolean): string {
  return (
    (chatSurface ? CHAT_POST_LEAD_SURFACE_ON : CHAT_POST_LEAD_NEUTRAL) +
    CHAT_POST_MECHANICS
  );
}

export function registerChatTools(
  server: McpServer,
  allowed: Set<string>,
  context: ChatToolsContext
): void {
  if (!context.chat) return;
  const chat = context.chat;
  const agentId = context.agentId;

  if (allowed.has("dispatch_chat_post")) {
    server.registerTool(
      "dispatch_chat_post",
      {
        description: buildChatPostDescription(context.chatSurface === true),
        inputSchema: {
          text: textSchema,
          kind: chatKindSchema.optional().describe('Default "reply".'),
          replyTo: z
            .uuid()
            .optional()
            .describe(
              "Id of the user message you are answering (from the DISPATCH CHAT envelope)."
            ),
          question: chatQuestionSchema.optional(),
          attachments: attachmentsSchema.optional(),
        },
      },
      async (args) => {
        try {
          const message = await chat.post(agentId, {
            text: args.text,
            kind: args.kind,
            replyTo: args.replyTo ?? null,
            question: args.question ?? null,
            attachments: args.attachments ?? [],
          });
          const result = { id: message.id, createdAt: message.createdAt };
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

  if (allowed.has("dispatch_chat_update")) {
    server.registerTool(
      "dispatch_chat_update",
      {
        description:
          "Revise a Chat tab message you posted earlier with dispatch_chat_post — e.g. turn a progress update into the final result, or fix a typo. " +
          "Only your own messages on this agent can be edited. Supply only the fields to change; attachments, when given, replace the whole list. " +
          'Changing kind to "question" requires question; changing away from it clears the question. Returns { id, updatedAt }. ' +
          'Editing an "update" post in place is the durable form of progress: keep revising the same message rather than posting a new note for every step.',
        inputSchema: {
          messageId: z.uuid().describe("Id returned by dispatch_chat_post."),
          text: textSchema.optional(),
          kind: chatKindSchema.optional(),
          question: chatQuestionSchema.optional(),
          attachments: attachmentsSchema.optional(),
        },
      },
      async (args) => {
        try {
          const message = await chat.update(agentId, args.messageId, {
            text: args.text,
            kind: args.kind,
            question: args.question,
            attachments: args.attachments,
          });
          const result = { id: message.id, updatedAt: message.updatedAt };
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
}
