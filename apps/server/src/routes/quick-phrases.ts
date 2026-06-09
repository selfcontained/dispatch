import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

import {
  createQuickPhrase,
  deleteQuickPhrase,
  listQuickPhrases,
} from "../db/quick-phrases.js";

const TEXT_MAX = 1000;

type QuickPhraseRouteDeps = {
  pool: Pool;
};

export async function registerQuickPhraseRoutes(
  app: FastifyInstance,
  deps: QuickPhraseRouteDeps
): Promise<void> {
  const { pool } = deps;

  app.get("/api/v1/quick-phrases", async () => {
    const phrases = await listQuickPhrases(pool);
    return { phrases };
  });

  app.post("/api/v1/quick-phrases", async (request, reply) => {
    const body = request.body as { text?: unknown } | null;
    const text = typeof body?.text === "string" ? body.text.trim() : "";

    if (!text) {
      return reply.code(400).send({ error: "text is required." });
    }
    if (text.length > TEXT_MAX) {
      return reply
        .code(400)
        .send({ error: `text must be ${TEXT_MAX} characters or fewer.` });
    }

    const phrase = await createQuickPhrase(pool, { text });
    return reply.code(201).send({ phrase });
  });

  app.delete("/api/v1/quick-phrases/:id", async (request, reply) => {
    const params = request.params as { id?: string };
    const id = params.id ?? "";
    const removed = await deleteQuickPhrase(pool, id);
    if (!removed) {
      return reply.code(404).send({ error: "Phrase not found." });
    }
    return reply.code(204).send();
  });
}
