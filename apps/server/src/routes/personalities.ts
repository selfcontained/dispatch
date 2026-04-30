import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

import {
  createPersonality,
  deletePersonality,
  getActivePersonalityId,
  getPersonality,
  listPersonalities,
  setActivePersonalityId,
  updatePersonality,
} from "../db/personalities.js";

const NAME_MAX = 80;
const PROMPT_MAX = 1000;

type PersonalityRouteDeps = {
  pool: Pool;
};

export async function registerPersonalityRoutes(
  app: FastifyInstance,
  deps: PersonalityRouteDeps
): Promise<void> {
  const { pool } = deps;

  app.get("/api/v1/personalities", async () => {
    const [personalities, activeId] = await Promise.all([
      listPersonalities(pool),
      getActivePersonalityId(pool),
    ]);
    return { personalities, activeId };
  });

  app.post("/api/v1/personalities", async (request, reply) => {
    const body = request.body as { name?: unknown; prompt?: unknown } | null;
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    const prompt = typeof body?.prompt === "string" ? body.prompt : "";

    if (!name) {
      return reply.code(400).send({ error: "name is required." });
    }
    if (name.length > NAME_MAX) {
      return reply
        .code(400)
        .send({ error: `name must be ${NAME_MAX} characters or fewer.` });
    }
    if (!prompt.trim()) {
      return reply.code(400).send({ error: "prompt is required." });
    }
    if (prompt.length > PROMPT_MAX) {
      return reply
        .code(400)
        .send({ error: `prompt must be ${PROMPT_MAX} characters or fewer.` });
    }

    try {
      const personality = await createPersonality(pool, { name, prompt });
      return reply.code(201).send({ personality });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.includes("personalities_name_key")) {
        return reply
          .code(409)
          .send({ error: "A personality with that name already exists." });
      }
      throw error;
    }
  });

  app.patch("/api/v1/personalities/:id", async (request, reply) => {
    const params = request.params as { id?: string };
    const id = params.id ?? "";
    const body = request.body as { name?: unknown; prompt?: unknown } | null;

    const existing = await getPersonality(pool, id);
    if (!existing) {
      return reply.code(404).send({ error: "Personality not found." });
    }

    let name: string | undefined;
    if (body?.name !== undefined) {
      if (typeof body.name !== "string") {
        return reply.code(400).send({ error: "name must be a string." });
      }
      const trimmed = body.name.trim();
      if (!trimmed) {
        return reply.code(400).send({ error: "name cannot be empty." });
      }
      if (trimmed.length > NAME_MAX) {
        return reply
          .code(400)
          .send({ error: `name must be ${NAME_MAX} characters or fewer.` });
      }
      name = trimmed;
    }

    let prompt: string | undefined;
    if (body?.prompt !== undefined) {
      if (typeof body.prompt !== "string") {
        return reply.code(400).send({ error: "prompt must be a string." });
      }
      if (!body.prompt.trim()) {
        return reply.code(400).send({ error: "prompt cannot be empty." });
      }
      if (body.prompt.length > PROMPT_MAX) {
        return reply
          .code(400)
          .send({ error: `prompt must be ${PROMPT_MAX} characters or fewer.` });
      }
      prompt = body.prompt;
    }

    try {
      const updated = await updatePersonality(pool, id, { name, prompt });
      if (!updated) {
        return reply.code(404).send({ error: "Personality not found." });
      }
      return { personality: updated };
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.includes("personalities_name_key")) {
        return reply
          .code(409)
          .send({ error: "A personality with that name already exists." });
      }
      throw error;
    }
  });

  app.delete("/api/v1/personalities/:id", async (request, reply) => {
    const params = request.params as { id?: string };
    const id = params.id ?? "";
    const removed = await deletePersonality(pool, id);
    if (!removed) {
      return reply.code(404).send({ error: "Personality not found." });
    }
    return reply.code(204).send();
  });

  app.post("/api/v1/personalities/active", async (request, reply) => {
    const body = request.body as { id?: unknown } | null;
    const id = body?.id;

    if (id === null || id === undefined) {
      await setActivePersonalityId(pool, null);
      return { activeId: null };
    }

    if (typeof id !== "string") {
      return reply.code(400).send({ error: "id must be a string or null." });
    }

    const personality = await getPersonality(pool, id);
    if (!personality) {
      return reply.code(404).send({ error: "Personality not found." });
    }

    await setActivePersonalityId(pool, id);
    return { activeId: id };
  });
}
