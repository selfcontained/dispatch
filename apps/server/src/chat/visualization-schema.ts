import * as z from "zod/v4";
import { CHART_TYPES, GRAPH_COLORS } from "@dispatch/shared";
const label = z.string().trim().min(1).max(160);
const numeric = z.number().finite().min(-1e15).max(1e15);
const meta = {
  version: z.literal(1),
  title: label,
  unit: label,
  dataKind: z.enum(["measured", "estimated", "synthetic"]),
  description: z.string().min(1).max(2000).optional(),
  source: z.string().min(1).max(2000).optional(),
  asOf: label.optional(),
};
export const metricSchema = z.strictObject({
  ...meta,
  value: numeric.nullable(),
  comparison: z.strictObject({ value: numeric, label }).optional(),
});
export const chartSchema = z.strictObject({
  ...meta,
  type: z.enum(CHART_TYPES),
  xLabel: label,
  xUnit: label.optional(),
  series: z
    .array(
      z.strictObject({
        id: z
          .string()
          .regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/)
          .max(64),
        label,
        color: z.enum(GRAPH_COLORS),
      })
    )
    .min(1)
    .max(6),
  points: z
    .array(
      z.strictObject({
        label,
        values: z.array(numeric.nullable()).max(6),
        x: numeric.optional(),
        from: numeric.optional(),
        to: numeric.optional(),
      })
    )
    .max(200),
});
export const visualizationGroupSchema = z.strictObject({
  version: z.literal(1),
  title: label.optional(),
  items: z
    .array(
      z.discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("metric"), data: metricSchema }),
        z.strictObject({ kind: z.literal("chart"), data: chartSchema }),
      ])
    )
    .min(1)
    .max(6),
});
