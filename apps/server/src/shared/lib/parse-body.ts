import type { FastifyReply } from "fastify";
import type * as z from "zod/v4";

export function parseBody<T extends z.ZodType>(
  schema: T,
  data: unknown,
  reply: FastifyReply
): z.infer<T> | undefined {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    reply.code(400).send({ error: parsed.error.issues[0].message });
    return undefined;
  }
  return parsed.data;
}
