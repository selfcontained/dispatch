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

export type ChatToolsContext = {
  agentId: string;
  chat?: Pick<ChatService, "post" | "update">;
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
    url: z.string().url(),
    title: z.string().max(200).optional(),
  }),
  z.object({
    type: z.literal("pr"),
    url: z.string().url(),
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
        description:
          "Post a message to the optional Chat tab of this session — a native chat view the user may have enabled alongside the terminal (Console). " +
          "Whether the user is reading Chat is set by the Dispatch startup rules; this tool only describes the mechanics. " +
          "Messages the user sends from Chat arrive in your session wrapped in a DISPATCH CHAT envelope carrying an id; set replyTo to that id when answering one. " +
          'kind: "reply" (default) for a normal message, "update" for a lightweight progress note, "summary" for a wrap-up card, ' +
          '"question" to request a decision — supply question.options (rendered as buttons, up to ' +
          `${CHAT_QUESTION_OPTIONS_MAX}) for a finite choice, and allowFreeform when a typed answer also works; the choice comes back as a user message with replyTo set to the question. ` +
          `text is markdown (≤ ${CHAT_MESSAGE_MAX_CHARS} chars). attachments (≤ ${CHAT_ATTACHMENTS_MAX}): ` +
          '{ type: "file", fileName } for a file already shared via dispatch_share_file (use the fileName it returned), { type: "link" | "pr", url, title? }, ' +
          '{ type: "code", code, language?, path? }, or { type: "pin", pinId }. Returns { id, createdAt }; use the id with dispatch_chat_update to revise the message later.',
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
          'Changing kind to "question" requires question; changing away from it clears the question. Returns { id, updatedAt }.',
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
