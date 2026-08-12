import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import type { Personality } from "../../db/personalities.js";
import { jsonText } from "./response.js";
import { toToolError } from "./tool-error.js";

const NAME_MAX = 80;
const PROMPT_MAX = 1000;

export type PersonalityToolCallbacks = {
  listPersonalities?: () => Promise<{
    personalities: Personality[];
    activeId: string | null;
  }>;
  createPersonality?: (input: {
    name: string;
    prompt: string;
  }) => Promise<Personality>;
  updatePersonality?: (
    id: string,
    input: { name?: string; prompt?: string }
  ) => Promise<Personality>;
  deletePersonality?: (id: string) => Promise<void>;
  setActivePersonality?: (id: string) => Promise<void>;
  clearActivePersonality?: () => Promise<void>;
};

export function registerPersonalityTools(
  server: McpServer,
  allowed: Set<string>,
  callbacks: PersonalityToolCallbacks
): void {
  if (allowed.has("list_personalities") && callbacks.listPersonalities) {
    const listPersonalities = callbacks.listPersonalities;
    server.registerTool(
      "list_personalities",
      {
        description:
          "List saved Dispatch personalities and the currently active personality ID. Personalities shape standard agents; they are unrelated to review personas.",
        inputSchema: {},
      },
      async () => {
        try {
          const result = await listPersonalities();
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

  if (allowed.has("create_personality") && callbacks.createPersonality) {
    const createPersonality = callbacks.createPersonality;
    server.registerTool(
      "create_personality",
      {
        description:
          "Create a saved Dispatch personality. It is not made active automatically.",
        inputSchema: {
          name: z.string().trim().min(1).max(NAME_MAX),
          prompt: z
            .string()
            .min(1)
            .max(PROMPT_MAX)
            .refine((value) => value.trim().length > 0, {
              message: "prompt cannot be blank.",
            }),
        },
      },
      async ({ name, prompt }) => {
        try {
          const personality = await createPersonality({ name, prompt });
          return {
            content: [
              {
                type: "text",
                text: `Created personality \"${personality.name}\" (${personality.id}).`,
              },
            ],
            structuredContent: { personality },
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }

  if (allowed.has("update_personality") && callbacks.updatePersonality) {
    const updatePersonality = callbacks.updatePersonality;
    server.registerTool(
      "update_personality",
      {
        description:
          "Update the name and/or prompt of a saved Dispatch personality.",
        inputSchema: {
          id: z.string().min(1),
          name: z.string().trim().min(1).max(NAME_MAX).optional(),
          prompt: z
            .string()
            .min(1)
            .max(PROMPT_MAX)
            .refine((value) => value.trim().length > 0, {
              message: "prompt cannot be blank.",
            })
            .optional(),
        },
      },
      async ({ id, name, prompt }) => {
        try {
          if (name === undefined && prompt === undefined) {
            throw new Error(
              "Provide name and/or prompt to update a personality."
            );
          }
          const personality = await updatePersonality(id, { name, prompt });
          return {
            content: [
              {
                type: "text",
                text: `Updated personality \"${personality.name}\" (${personality.id}).`,
              },
            ],
            structuredContent: { personality },
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }

  if (allowed.has("delete_personality") && callbacks.deletePersonality) {
    const deletePersonality = callbacks.deletePersonality;
    server.registerTool(
      "delete_personality",
      {
        description:
          "Delete a saved Dispatch personality. If it is active, the active personality is cleared.",
        inputSchema: { id: z.string().min(1) },
      },
      async ({ id }) => {
        try {
          await deletePersonality(id);
          return {
            content: [{ type: "text", text: `Deleted personality ${id}.` }],
            structuredContent: { id, deleted: true },
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }

  if (allowed.has("set_active_personality") && callbacks.setActivePersonality) {
    const setActivePersonality = callbacks.setActivePersonality;
    server.registerTool(
      "set_active_personality",
      {
        description:
          "Set a saved Dispatch personality as active for subsequently launched standard agents.",
        inputSchema: { id: z.string().min(1) },
      },
      async ({ id }) => {
        try {
          await setActivePersonality(id);
          return {
            content: [
              { type: "text", text: `Set active personality to ${id}.` },
            ],
            structuredContent: { activeId: id },
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }

  if (
    allowed.has("clear_active_personality") &&
    callbacks.clearActivePersonality
  ) {
    const clearActivePersonality = callbacks.clearActivePersonality;
    server.registerTool(
      "clear_active_personality",
      {
        description:
          "Clear the active Dispatch personality so subsequently launched standard agents receive no personality text.",
        inputSchema: {},
      },
      async () => {
        try {
          await clearActivePersonality();
          return {
            content: [
              { type: "text", text: "Cleared the active personality." },
            ],
            structuredContent: { activeId: null },
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }
}
