import type { FastifyReply } from "fastify";
import type { ZodObject } from "zod/v4";
import type * as z from "zod/v4";

export function parseInput<T extends ZodObject>(
  schema: T,
  data: unknown,
  reply: FastifyReply
): z.output<T> | undefined {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    reply.code(400).send({ error: parsed.error.issues[0].message });
    return undefined;
  }
  return parsed.data;
}
