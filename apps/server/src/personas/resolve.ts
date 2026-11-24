import type { AgentManager, AgentRecord } from "../agents/manager.js";
import { RunnerCapabilityUnavailable } from "../agents/remote/service.js";
import { readAgentCheckoutFile } from "../server/mcp-checkout.js";
import type { PersonaScope } from "./persona-scope.js";
import { PERSONA_DIRS } from "./paths.js";
import {
  loadPersonaBySlug,
  loadPersonaFromCheckout,
  loadCheckoutPersonas,
  loadPersonas,
  mergePersonasWithWorktreePrecedence,
  supportsPersonaType,
  type PersonaDefinition,
} from "./loader.js";
import {
  appendBuiltInPersonas,
  BUILT_IN_PERSONAS,
  getBuiltInPersona,
} from "./built-in.js";
import { resolveWorktreeRoot } from "../shared/git/git-context.js";
import {
  personaCatalog,
  parseDefaultBranchPersonas,
  type PersonaCatalog,
} from "./catalog.js";
import { RunnerCallError } from "@dispatch/runner-protocol/contract";

async function sessionDefaultBranchPersonas(
  manager: Pick<AgentManager, "inspectCheckout">,
  agent: AgentRecord,
  waitForRefresh: boolean
) {
  try {
    const reply = await manager.inspectCheckout(agent, {
      kind: "defaultBranchFiles",
      directories: [...PERSONA_DIRS],
      waitForRefresh,
    });
    if (reply.kind !== "defaultBranchFiles")
      throw new Error("Runner did not return default-branch files.");
    return parseDefaultBranchPersonas(reply);
  } catch (error) {
    if (!(error instanceof RunnerCapabilityUnavailable)) throw error;
    return {
      personas: [],
      warnings: [error.message],
      refreshing: false,
      updatedAt: null,
    };
  }
}

const emptyCatalog: PersonaCatalog = {
  personas: [],
  warnings: [],
  refreshing: false,
  updatedAt: null,
};

/**
 * A runner that cannot read the repository: an older peer, one that is
 * offline or drops the connection, or a repository URL a launch would
 * refuse. Those keep today's answer; only a failure the runner reports
 * reaches the user.
 */
const readsElsewhere = (error: unknown) =>
  !(error instanceof RunnerCallError) ||
  error.code === "unsupported" ||
  error.code === "unavailable" ||
  error.code === "invalid";

type Sources = {
  load: (
    warnings: string[]
  ) => Promise<PersonaDefinition[]> | PersonaDefinition[];
  loadSlug: (slug: string) => Promise<PersonaDefinition | null> | null;
  catalog: (wait: boolean) => Promise<PersonaCatalog>;
} | null;

async function personaSources(scope: PersonaScope): Promise<Sources> {
  if (scope.kind === "repository") {
    // No checkout exists yet: only the repository's default branch, read
    // on the runner the launch goes to and parsed here.
    const fallback = await personaSources(scope.fallback);
    return {
      load: () => [],
      loadSlug: () => null,
      catalog: async (wait: boolean) => {
        try {
          return await parseDefaultBranchPersonas({
            kind: "defaultBranchFiles",
            ...(await scope.read([...PERSONA_DIRS], wait)),
          });
        } catch (error) {
          if (!readsElsewhere(error)) throw error;
          return fallback ? fallback.catalog(wait) : emptyCatalog;
        }
      },
    };
  }
  if (scope.kind === "session") {
    const { manager, agent } = scope;
    const readFile = (path: string) =>
      readAgentCheckoutFile(manager, agent, path);
    return {
      // Difference from main (recorded, T35): the checkout listing names
      // regular files and links to files only, so a directory, dangling link
      // or FIFO named `*.md` is skipped silently where main's readdir warns.
      load: (warnings: string[]) =>
        loadCheckoutPersonas(
          async (path) => {
            const reply = await manager.inspectCheckout(agent, {
              kind: "listFiles",
              path,
            });
            if (reply.kind !== "listFiles")
              throw new Error("Runner did not return a file list.");
            return reply.names;
          },
          readFile,
          warnings
        ),
      loadSlug: (slug: string) => loadPersonaFromCheckout(slug, readFile),
      catalog: (wait: boolean) =>
        sessionDefaultBranchPersonas(manager, agent, wait),
    };
  }
  if (scope.kind === "builtins") return null;
  const cwd = scope.kind === "folder" ? scope.cwd : scope.repoRoot;
  const root = await resolveWorktreeRoot(cwd).catch(() => cwd);
  const workspace = scope.kind === "folder" && scope.source === "workspace";
  return {
    load: (warnings: string[]) =>
      workspace ? loadPersonas(root, warnings) : [],
    loadSlug: (slug: string) =>
      workspace ? loadPersonaBySlug(root, slug) : null,
    catalog: (wait: boolean) => personaCatalog.get(root, wait),
  };
}

export async function listPersonas(
  scope: PersonaScope,
  type?: "task" | "review",
  waitForRefresh = false
) {
  const sources = await personaSources(scope);
  const warnings: string[] = [];
  const local = (await sources?.load(warnings)) ?? [];
  const catalog = sources
    ? await sources.catalog(waitForRefresh).catch((error) => {
        if (scope.kind !== "session") throw error;
        return {
          ...emptyCatalog,
          warnings: ["Could not read default-branch files from the runner."],
        };
      })
    : emptyCatalog;
  const personas = appendBuiltInPersonas(
    mergePersonasWithWorktreePrecedence({
      worktreePersonas: local,
      repoPersonas: catalog.personas,
    }),
    BUILT_IN_PERSONAS
  );
  return {
    ...catalog,
    // Main reads the catalog first, then the checkout's own files.
    warnings: [...catalog.warnings, ...warnings],
    personas: type
      ? personas.filter((p) => supportsPersonaType(p, type))
      : personas,
  };
}

export async function resolvePersona(
  scope: PersonaScope,
  slug: string,
  type?: "task" | "review"
): Promise<PersonaDefinition> {
  if (slug.includes("/") || slug.includes("\\") || slug.includes(".."))
    throw new Error("Invalid persona slug.");
  const sources = await personaSources(scope);
  // A malformed checkout override must fail explicitly.
  let persona: PersonaDefinition | null | undefined =
    await sources?.loadSlug(slug);
  if (sources && !persona) {
    const catalog = await sources.catalog(true);
    persona = catalog.personas.find((p) => p.slug === slug);
    if (!persona && catalog.refreshing)
      throw new Error(
        "Persona catalog is still refreshing. Try again shortly."
      );
  }
  persona ??= getBuiltInPersona(slug);
  if (!persona) throw new Error(`Persona "${slug}" not found.`);
  if (type && !supportsPersonaType(persona, type))
    throw new Error(`Persona "${slug}" is not available for ${type} launches.`);
  if (!persona.body.trim())
    throw new Error(`Persona "${slug}" has no instructions.`);
  return persona;
}
