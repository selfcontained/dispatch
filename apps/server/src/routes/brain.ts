import type { FastifyInstance, FastifyReply } from "fastify";

import {
  BRAIN_ENTRY_TYPES,
  BrainValidationError,
  toEntryTypeDeleteScope,
  type BrainStore,
} from "../brain/store.js";

type BrainRouteDeps = {
  brainStore: BrainStore;
};

/**
 * Duplicate query keys ("?collection=a&collection=b") parse into arrays, so a
 * querystring value is not the string its type claims until this says so.
 */
function isSingleValue(
  value: string | string[] | undefined
): value is string | undefined {
  return value === undefined || typeof value === "string";
}

/**
 * Runs a store call, answering 400 when the store rejects the request as
 * invalid. Every route reaching a store method that can throw
 * BrainValidationError goes through here — there is no app-level error handler,
 * so an unmapped throw surfaces as a 500 with the raw message.
 */
async function mapBrainValidation<T>(
  reply: FastifyReply,
  run: () => Promise<T>
): Promise<T | FastifyReply> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof BrainValidationError) {
      return reply.code(400).send({ error: error.message });
    }
    throw error;
  }
}

export async function registerBrainRoutes(
  app: FastifyInstance,
  deps: BrainRouteDeps
): Promise<void> {
  const { brainStore } = deps;

  app.get("/api/v1/brain/projects", async () => {
    return await brainStore.listProjects();
  });

  app.delete<{ Querystring: { repoRoot?: string } }>(
    "/api/v1/brain/projects",
    async (request, reply) => {
      const { repoRoot } = request.query;
      if (!repoRoot) {
        return reply.code(400).send({ error: "repoRoot is required." });
      }
      return await brainStore.deleteProject(repoRoot);
    }
  );

  app.get<{ Querystring: { repoRoot?: string } }>(
    "/api/v1/brain/collections",
    async (request, reply) => {
      const { repoRoot } = request.query;
      if (!repoRoot) {
        return reply.code(400).send({ error: "repoRoot is required." });
      }
      return await brainStore.listCollections(repoRoot);
    }
  );

  app.get<{
    Querystring: {
      repoRoot?: string;
      collection?: string;
      prefix?: string;
      limit?: string;
    };
  }>("/api/v1/brain/objects", async (request, reply) => {
    const { repoRoot, collection, prefix, limit } = request.query;
    if (!repoRoot) {
      return reply.code(400).send({ error: "repoRoot is required." });
    }
    return await brainStore.listObjects(repoRoot, {
      collection: collection || undefined,
      namePrefix: prefix || undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  });

  app.get<{
    Params: { collection: string; name: string };
    Querystring: { repoRoot?: string };
  }>("/api/v1/brain/objects/:collection/:name", async (request, reply) => {
    const { repoRoot } = request.query;
    if (!repoRoot) {
      return reply.code(400).send({ error: "repoRoot is required." });
    }
    const obj = await brainStore.getObject(
      repoRoot,
      request.params.collection,
      request.params.name
    );
    if (!obj) {
      return reply.code(404).send({ error: "Object not found." });
    }
    return obj;
  });

  app.delete<{
    Params: { collection: string; name: string };
    Querystring: { repoRoot?: string };
  }>("/api/v1/brain/objects/:collection/:name", async (request, reply) => {
    const { repoRoot } = request.query;
    if (!repoRoot) {
      return reply.code(400).send({ error: "repoRoot is required." });
    }
    return {
      deleted: await brainStore.deleteObject(
        repoRoot,
        request.params.collection,
        request.params.name
      ),
    };
  });

  app.delete<{
    Params: { collection: string };
    Querystring: { repoRoot?: string };
  }>("/api/v1/brain/collections/:collection", async (request, reply) => {
    const { repoRoot } = request.query;
    if (!repoRoot) {
      return reply.code(400).send({ error: "repoRoot is required." });
    }
    return await mapBrainValidation(reply, () =>
      brainStore.deleteCollection(repoRoot, request.params.collection)
    );
  });

  app.get<{
    Querystring: { repoRoot?: string; collection?: string; limit?: string };
  }>("/api/v1/brain/lists", async (request, reply) => {
    const { repoRoot, collection, limit } = request.query;
    if (!repoRoot) {
      return reply.code(400).send({ error: "repoRoot is required." });
    }
    return await brainStore.listLists(repoRoot, {
      collection: collection || undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  });

  app.get<{
    Params: { collection: string; name: string };
    Querystring: {
      repoRoot?: string;
      limit?: string;
      offset?: string;
      order?: string;
    };
  }>("/api/v1/brain/lists/:collection/:name", async (request, reply) => {
    const { repoRoot, limit, offset, order } = request.query;
    if (!repoRoot) {
      return reply.code(400).send({ error: "repoRoot is required." });
    }
    return await brainStore.getListItems(repoRoot, {
      collection: request.params.collection,
      name: request.params.name,
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
      order: order === "asc" ? "asc" : "desc",
    });
  });

  app.delete<{
    Params: { collection: string; name: string };
    Querystring: { repoRoot?: string };
  }>("/api/v1/brain/lists/:collection/:name", async (request, reply) => {
    const { repoRoot } = request.query;
    if (!repoRoot) {
      return reply.code(400).send({ error: "repoRoot is required." });
    }
    return {
      deleted: await brainStore.deleteList(
        repoRoot,
        request.params.collection,
        request.params.name
      ),
    };
  });

  app.get<{
    Querystring: {
      repoRoot?: string;
      collection?: string;
      kind?: string;
      subject?: string;
      tags?: string;
      since?: string;
      until?: string;
      limit?: string;
    };
  }>("/api/v1/brain/events", async (request, reply) => {
    const { repoRoot, collection, kind, subject, tags, since, until, limit } =
      request.query;
    if (!repoRoot) {
      return reply.code(400).send({ error: "repoRoot is required." });
    }
    return await brainStore.queryEvents(repoRoot, {
      collection: collection || undefined,
      kind: kind || undefined,
      subject: subject || undefined,
      tags: tags ? tags.split(",") : undefined,
      since: since || undefined,
      until: until || undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  });

  app.delete<{
    Params: { id: string };
    Querystring: { repoRoot?: string };
  }>("/api/v1/brain/events/:id", async (request, reply) => {
    const { repoRoot } = request.query;
    if (!repoRoot) {
      return reply.code(400).send({ error: "repoRoot is required." });
    }
    return {
      deleted: await brainStore.deleteEvent(repoRoot, request.params.id),
    };
  });

  app.get<{
    Params: { agentId: string };
    Querystring: { repoRoot?: string; limit?: string };
  }>("/api/v1/brain/agent-activity/:agentId", async (request, reply) => {
    const { repoRoot, limit } = request.query;
    if (!repoRoot) {
      return reply.code(400).send({ error: "repoRoot is required." });
    }
    return await brainStore.getAgentBrainActivity(
      repoRoot,
      request.params.agentId,
      limit ? parseInt(limit, 10) : undefined
    );
  });

  /**
   * Bulk delete for one entry type — registers DELETE /api/v1/brain/objects,
   * /api/v1/brain/lists, and /api/v1/brain/events.
   *
   * Only the HTTP-shaped rules live here: rejecting array-valued query keys,
   * requiring repoRoot, and coercing allCollections from a string. What counts
   * as a legal scope is toEntryTypeDeleteScope's call, so the route and the
   * store cannot drift on it.
   */
  for (const entryType of BRAIN_ENTRY_TYPES) {
    app.delete<{
      // Typed as the values Fastify can actually produce, not the ones we want.
      Querystring: {
        repoRoot?: string | string[];
        collection?: string | string[];
        allCollections?: string | string[];
      };
    }>(`/api/v1/brain/${entryType}`, async (request, reply) => {
      const { repoRoot, collection, allCollections } = request.query;
      if (
        !isSingleValue(repoRoot) ||
        !isSingleValue(collection) ||
        !isSingleValue(allCollections)
      ) {
        return reply.code(400).send({
          error:
            "repoRoot, collection, and allCollections each accept a single value.",
        });
      }
      if (!repoRoot) {
        return reply.code(400).send({ error: "repoRoot is required." });
      }

      return await mapBrainValidation(reply, () => {
        const scope = toEntryTypeDeleteScope({
          collection,
          allCollections: allCollections === "true",
        });
        return brainStore.deleteEntriesOfType(repoRoot, entryType, scope);
      });
    });
  }
}
