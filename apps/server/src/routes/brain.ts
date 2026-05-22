import type { FastifyInstance } from "fastify";

import type { BrainStore } from "../brain/store.js";

type BrainRouteDeps = {
  brainStore: BrainStore;
  publishUiEvent: (event: unknown) => void;
};

export async function registerBrainRoutes(
  app: FastifyInstance,
  deps: BrainRouteDeps
): Promise<void> {
  const { brainStore } = deps;

  app.get("/api/v1/brain/projects", async () => {
    return await brainStore.listProjects();
  });

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
}
