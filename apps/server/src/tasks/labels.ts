import { z } from "zod";

export const LABEL_COLORS = [
  "gray",
  "red",
  "orange",
  "green",
  "blue",
  "purple",
] as const;
/** Project names are trimmed, case-insensitive, 1–40 characters; max 20 per task. */
export const taskLabelsSchema = z
  .array(
    z.object({
      name: z
        .string()
        .trim()
        .min(1)
        .max(40)
        .regex(/^[^\x00-\x1f\x7f]+$/),
      color: z.enum(LABEL_COLORS).default("gray"),
    })
  )
  .max(20)
  .transform((labels) => [
    ...new Map(
      labels.map((label) => [label.name.toLowerCase(), label])
    ).values(),
  ]);
