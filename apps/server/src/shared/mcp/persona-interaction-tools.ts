import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import {
  appendBuiltInPersonas,
  BUILT_IN_PERSONA_SUMMARIES,
  GENERIC_REVIEW_PERSONA_SLUG,
} from "../../personas/built-in.js";
import { mergePersonasWithWorktreePrecedence } from "../../personas/loader.js";
import {
  getPersonaTemplate,
  PERSONA_TEMPLATES,
  upsertPersona,
  validatePersonas,
} from "../../personas/authoring.js";
import { describeAgentModelCatalog } from "../agent-models.js";
import { CLI_AGENT_TYPES, type CliAgentType } from "../agent-types.js";
import type { McpRequestContext } from "./server.js";
import { jsonText } from "./response.js";
import { toToolError } from "./tool-error.js";

// A persona launch runs an AI CLI, so it takes the shared CLI subset. Aliased
// rather than re-exported directly because both names are already part of this
// module's surface (server.ts imports the type).
export const LAUNCH_PERSONA_AGENT_TYPES = CLI_AGENT_TYPES;
export type LaunchPersonaAgentType = CliAgentType;

export type PersonaInteractionCallbacks = {
  agentId: string;
  parentAgentId?: string | null;
  worktreeRoot?: string | null;
  repoRoot?: string | null;
  listPersonas?: McpRequestContext["listPersonas"];
};

type PersonaSummary = { slug: string; name: string; description: string };

export async function resolvePersonaList(
  listPersonas: (root: string) => Promise<PersonaSummary[]>,
  worktreeRoot?: string | null,
  repoRoot?: string | null
): Promise<PersonaSummary[]> {
  const worktreePersonas = worktreeRoot
    ? await listPersonas(worktreeRoot).catch(() => [])
    : [];
  const repoPersonas =
    repoRoot && repoRoot !== worktreeRoot
      ? await listPersonas(repoRoot).catch(() => [])
      : [];

  return appendBuiltInPersonas(
    mergePersonasWithWorktreePrecedence({
      worktreePersonas,
      repoPersonas,
    }),
    BUILT_IN_PERSONA_SUMMARIES
  );
}

export function registerPersonaInteractionTools(
  server: McpServer,
  allowed: Set<string>,
  callbacks: PersonaInteractionCallbacks
): void {
  const { agentId } = callbacks;

  const personaRoot = callbacks.worktreeRoot ?? callbacks.repoRoot;

  if (allowed.has("persona_templates")) {
    server.registerTool(
      "persona_templates",
      {
        description:
          "Return concise examples and exact authoring fields for repository-specific review personas. Use these as a starting point, then create a tailored persona with persona_upsert.",
        inputSchema: {},
      },
      async () => ({
        content: [
          {
            type: "text",
            text: jsonText({ templates: PERSONA_TEMPLATES }),
          },
        ],
        structuredContent: { templates: PERSONA_TEMPLATES },
      })
    );
  }

  if (allowed.has("persona_upsert") && personaRoot) {
    server.registerTool(
      "persona_upsert",
      {
        description:
          "Create or update a repository persona in .dispatch/personas/. Provide repo-specific instructions; optionally start from a short built-in template. This writes only in the current workspace.",
        inputSchema: {
          slug: z.string().min(1).max(80),
          template: z
            .string()
            .optional()
            .describe("Optional template ID returned by persona_templates."),
          name: z.string().max(200).optional(),
          description: z.string().max(500).optional(),
          instructions: z.string().max(20_000).optional(),
          feedbackFormat: z.string().max(100).optional(),
        },
      },
      async (args) => {
        try {
          const template = args.template
            ? getPersonaTemplate(args.template)
            : undefined;
          if (args.template && !template)
            throw new Error(
              `Unknown persona template: ${args.template}. Call persona_templates for available IDs.`
            );
          const name = args.name ?? template?.name;
          const description = args.description ?? template?.personaDescription;
          const instructions = args.instructions ?? template?.instructions;
          if (!name || !description || !instructions)
            throw new Error(
              "name, description, and instructions are required unless supplied by a template."
            );
          const result = await upsertPersona({
            root: personaRoot,
            slug: args.slug,
            name,
            description,
            instructions,
            feedbackFormat: args.feedbackFormat,
          });
          return {
            content: [
              {
                type: "text",
                text: `${result.created ? "Created" : "Updated"} ${result.path}.`,
              },
            ],
            structuredContent: result,
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }

  if (allowed.has("persona_validate") && personaRoot) {
    server.registerTool(
      "persona_validate",
      {
        description:
          "Validate persona files in the current workspace. Reports required metadata and instruction errors without modifying files.",
        inputSchema: {},
      },
      async () => {
        try {
          const personas = await validatePersonas(personaRoot);
          const valid = personas.every((persona) => persona.valid);
          return {
            content: [
              {
                type: "text",
                text:
                  personas.length === 0
                    ? "No persona files found."
                    : valid
                      ? `All ${personas.length} persona file(s) are valid.`
                      : `${personas.filter((persona) => !persona.valid).length} invalid persona file(s) found.`,
              },
            ],
            structuredContent: { valid, personas },
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }


  // ── list_personas ────────────────────────────────────────────────
  if (allowed.has("list_personas") && callbacks.listPersonas) {
    const listPersonas = callbacks.listPersonas;
    const { worktreeRoot, repoRoot } = callbacks;

    server.registerTool(
      "list_personas",
      {
        description:
          "List the personas available for this project: each one's slug, name and description — the repo's own personas plus Dispatch's built-in generalist reviewer. Launch one with launch_agent and its slug as persona.",
        inputSchema: {},
      },
      async () => {
        try {
          const personas = await resolvePersonaList(
            listPersonas,
            worktreeRoot,
            repoRoot
          );
          return {
            content: [{ type: "text", text: jsonText({ personas }) }],
            structuredContent: { personas },
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }
}
