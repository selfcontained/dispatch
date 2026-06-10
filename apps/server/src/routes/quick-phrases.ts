import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

import {
  createQuickPhrase,
  deleteQuickPhrase,
  listQuickPhrases,
  updateQuickPhrase,
  type QuickPhrase,
} from "../db/quick-phrases.js";
import { parseTemplateArgs } from "../templates/arg-parser.js";

const TEXT_MAX = 1000;
const LABEL_MAX = 200;

function withArgs(phrase: QuickPhrase) {
  return { ...phrase, args: parseTemplateArgs(phrase.text) };
}

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
    return { phrases: phrases.map(withArgs) };
  });

  app.post("/api/v1/quick-phrases", async (request, reply) => {
    const body = request.body as {
      text?: unknown;
      label?: unknown;
    } | null;
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    const label = typeof body?.label === "string" ? body.label.trim() : null;

    if (!text) {
      return reply.code(400).send({ error: "text is required." });
    }
    if (text.length > TEXT_MAX) {
      return reply
        .code(400)
        .send({ error: `text must be ${TEXT_MAX} characters or fewer.` });
    }
    if (label && label.length > LABEL_MAX) {
      return reply
        .code(400)
        .send({ error: `label must be ${LABEL_MAX} characters or fewer.` });
    }

    const phrase = await createQuickPhrase(pool, {
      text,
      label: label || null,
    });
    return reply.code(201).send({ phrase: withArgs(phrase) });
  });

  app.patch("/api/v1/quick-phrases/:id", async (request, reply) => {
    const params = request.params as { id?: string };
    const id = params.id ?? "";
    const body = request.body as {
      text?: unknown;
      label?: unknown;
    } | null;

    const updates: { text?: string; label?: string | null } = {};

    if (body && "text" in body) {
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text) {
        return reply.code(400).send({ error: "text must not be empty." });
      }
      if (text.length > TEXT_MAX) {
        return reply
          .code(400)
          .send({ error: `text must be ${TEXT_MAX} characters or fewer.` });
      }
      updates.text = text;
    }

    if (body && "label" in body) {
      const label = typeof body.label === "string" ? body.label.trim() : null;
      if (label && label.length > LABEL_MAX) {
        return reply
          .code(400)
          .send({ error: `label must be ${LABEL_MAX} characters or fewer.` });
      }
      updates.label = label || null;
    }

    if (Object.keys(updates).length === 0) {
      return reply
        .code(400)
        .send({ error: "At least one field (text, label) must be provided." });
    }

    const phrase = await updateQuickPhrase(pool, id, updates);
    if (!phrase) {
      return reply.code(404).send({ error: "Phrase not found." });
    }
    return { phrase: withArgs(phrase) };
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
