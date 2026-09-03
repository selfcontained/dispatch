import * as z from "zod/v4";
import type {
  SurfaceBlock as SharedSurfaceBlock,
  SurfaceDocumentInput as SharedSurfaceDocumentInput,
  SurfaceIcon,
  SurfaceInteractionRequest,
  SurfaceInteractionStatus,
  SurfaceLifecycle,
} from "@dispatch/shared";
import { SURFACE_FOOTER_BLOCK_ID } from "@dispatch/shared";

export const SURFACE_ICONS = [
  "layout",
  "list",
  "table",
  "checklist",
  "message",
  "flag",
  "clock",
  "sparkles",
  "form",
] as const satisfies readonly SurfaceIcon[];
export const surfaceIconSchema = z.enum(SURFACE_ICONS);
const idSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const titleSchema = z.string().trim().min(1).max(80);
const constrainedMarkdown = (max: number) =>
  z
    .string()
    .max(max)
    .refine(
      (value) => !/<[A-Za-z!/][^>]*>|!\[[^\]]*\]\([^)]*\)/.test(value),
      "raw HTML and embedded images are not supported"
    );
const descriptionSchema = constrainedMarkdown(240);
const base = {
  id: idSchema,
  title: titleSchema.optional(),
  description: descriptionSchema.optional(),
};
const scalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const tableCellScalarSchema = z.union([
  z.string().max(500),
  z.number(),
  z.boolean(),
  z.null(),
]);
const toneSchema = z.enum(["neutral", "info", "success", "warning", "danger"]);

function isAllowedTableUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const protocol = new URL(value).protocol;
    return (
      protocol === "http:" || protocol === "https:" || protocol === "mailto:"
    );
  } catch {
    return false;
  }
}

const actionSchema = z
  .object({
    id: idSchema,
    label: z.string().trim().min(1).max(48),
    intent: z.string().trim().min(1).max(80),
    style: z.enum(["default", "primary", "destructive"]).optional(),
    icon: surfaceIconSchema.optional(),
    confirm: z
      .object({
        title: z.string().trim().min(1).max(120),
        description: z.string().max(500).optional(),
      })
      .optional(),
    disabled: z.boolean().optional(),
    disabledReason: z.string().max(240).optional(),
  })
  .strict();
// A form submit is by definition its form's primary action, so it carries no
// style knob — the renderer always gives it primary weight.
const submitActionSchema = actionSchema.omit({ style: true });
/** Slot actions: 1 renders inline / as the split-button main; more collapse
 * into the overflow menu. Small caps keep the slot a decision, not a menu. */
const slotActionsSchema = z.array(actionSchema).min(1).max(4);
const itemActionSchema = actionSchema.pick({
  id: true,
  label: true,
  intent: true,
});
const itemActionsSchema = z.array(itemActionSchema).min(1).max(4);
const collapseSchema = z
  .object({
    after: z.number().int().min(1).max(99),
    label: z.string().trim().min(1).max(80).optional(),
  })
  .strict();

const optionSchema = z
  .object({
    value: z.string().min(1).max(200),
    label: z.string().min(1).max(120),
    description: z.string().max(240).optional(),
    disabled: z.boolean().optional(),
  })
  .strict();
const fieldCommon = {
  id: idSchema,
  label: z.string().trim().min(1).max(120),
  description: z.string().max(240).optional(),
  required: z.boolean().optional(),
};
const fieldSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...fieldCommon,
      type: z.enum(["text", "textarea"]),
      placeholder: z.string().max(240).optional(),
      defaultValue: z.string().optional(),
      minLength: z.number().int().min(0).optional(),
      maxLength: z.number().int().min(1).max(8000).optional(),
    })
    .strict(),
  z
    .object({
      ...fieldCommon,
      type: z.literal("select"),
      multiple: z.boolean().optional(),
      options: z.array(optionSchema).min(1).max(50),
      defaultValue: z
        .union([z.string(), z.array(z.string()).max(50)])
        .optional(),
    })
    .strict(),
  z
    .object({
      ...fieldCommon,
      type: z.literal("radio"),
      options: z.array(optionSchema).min(1).max(50),
      defaultValue: z.string().optional(),
    })
    .strict(),
  z
    .object({
      ...fieldCommon,
      type: z.literal("checkbox"),
      defaultValue: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      ...fieldCommon,
      type: z.literal("number"),
      min: z.number().optional(),
      max: z.number().optional(),
      step: z.number().positive().optional(),
      defaultValue: z.number().optional(),
    })
    .strict(),
]);

const statusBlockSchema = z
  .object({
    ...base,
    type: z.literal("status"),
    status: z.string().trim().min(1).max(40),
    tone: toneSchema.optional(),
    detail: constrainedMarkdown(1000).optional(),
    timestamp: z.iso.datetime().optional(),
  })
  .strict();
const progressBlockSchema = z
  .object({
    ...base,
    type: z.literal("progress"),
    value: z.number().min(0),
    max: z.number().positive(),
    label: z.string().max(120).optional(),
    detail: constrainedMarkdown(1000).optional(),
    tone: z.enum(["neutral", "info", "success", "warning"]).optional(),
  })
  .strict();

const leafBlockSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...base,
      type: z.literal("text"),
      text: constrainedMarkdown(8000),
      // Renders the block as a callout; reserve for decision-changing prose.
      tone: toneSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("list"),
      style: z.enum(["bullet", "number", "check"]).optional(),
      items: z
        .array(
          z
            .object({
              id: idSchema,
              text: constrainedMarkdown(500),
              status: z.string().trim().min(1).max(80).optional(),
              tone: toneSchema.optional(),
              checked: z.boolean().optional(),
              detail: constrainedMarkdown(240).optional(),
              url: z
                .string()
                .max(2000)
                .refine(isAllowedTableUrl, {
                  message: "List item URL must use http, https, or mailto",
                })
                .optional(),
              group: z.string().trim().min(1).max(80).optional(),
              actions: itemActionsSchema.optional(),
            })
            .strict()
        )
        .max(100),
      collapse: collapseSchema.optional(),
      showItemCount: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("table"),
      showItemCount: z.boolean().optional(),
      columns: z
        .array(
          z
            .object({
              id: idSchema,
              label: z.string().min(1).max(80),
              format: z
                .enum(["text", "number", "date", "badge", "code", "url"])
                .optional(),
              // Maps a visible badge value to its semantic treatment. Scalar cells
              // remain the wire format, so existing table documents stay valid.
              badgeVariants: z
                .record(z.string().max(200), toneSchema)
                .refine((variants) => Object.keys(variants).length <= 50, {
                  message: "badgeVariants supports at most 50 entries",
                })
                .optional(),
              align: z.enum(["left", "right"]).optional(),
              // "secondary" always renders behind a per-row disclosure (the
              // rail is a fixed width, not a breakpoint) — reserve it for
              // verbose diagnostics, never a decision-critical value.
              priority: z.enum(["primary", "secondary"]).optional(),
            })
            .strict()
        )
        .min(1)
        .max(6),
      rows: z
        .array(
          z
            .object({
              id: idSchema,
              cells: z.record(z.string(), tableCellScalarSchema),
              actions: itemActionsSchema.optional(),
            })
            .strict()
        )
        .max(100),
    })
    .strict(),
  statusBlockSchema,
  progressBlockSchema,
  z
    .object({
      ...base,
      type: z.literal("form"),
      fields: z.array(fieldSchema).min(1).max(20),
      submit: submitActionSchema,
      resetLabel: z.string().min(1).max(48).optional(),
      submitMode: z.enum(["once", "repeatable"]).optional(),
    })
    .strict(),
]);

const MAX_SECTION_DEPTH = 4;
const MAX_SECTION_CHILDREN = 20;
const MAX_NESTED_BLOCKS = 100;
const MAX_PRIMARY_TABLE_COLUMNS = 3;
export const MAX_SURFACE_TOP_LEVEL_BLOCKS = 100;
const sectionCollapseSchema = z
  .object({ initiallyCollapsed: z.boolean().optional() })
  .strict();

function blockSchemaAtDepth(depth: number): z.ZodType<SharedSurfaceBlock> {
  const childSchema =
    depth < MAX_SECTION_DEPTH ? blockSchemaAtDepth(depth + 1) : z.never();
  return z.union([
    leafBlockSchema,
    z
      .object({
        ...base,
        type: z.literal("section"),
        // A section heading is always visible, including when its body is collapsed.
        title: titleSchema,
        blocks: z.array(childSchema).min(1).max(MAX_SECTION_CHILDREN),
        // The section's footer slot: verbs that act on this group.
        actions: slotActionsSchema.optional(),
        collapse: sectionCollapseSchema.optional(),
      })
      .strict(),
  ]) as z.ZodType<SharedSurfaceBlock>;
}

/**
 * Nested sections are limited to four levels below the document root and 20
 * children per section. Top-level blocks have a 100-item cap; the
 * document refinement separately caps nested descendants at 100.
 */
export const surfaceBlockSchema = blockSchemaAtDepth(0);

export const surfaceHeaderSchema = z
  .object({
    status: statusBlockSchema.optional(),
    progress: progressBlockSchema.optional(),
  })
  .strict();
export const surfaceFooterSchema = z
  .object({ actions: slotActionsSchema })
  .strict();

export const surfaceDocumentSchema = z
  .object({
    title: z.string().trim().min(1).max(32),
    icon: surfaceIconSchema.optional(),
    header: surfaceHeaderSchema.optional(),
    blocks: z.array(surfaceBlockSchema).max(MAX_SURFACE_TOP_LEVEL_BLOCKS),
    footer: surfaceFooterSchema.optional(),
  })
  .strict()
  .superRefine((doc, ctx) => {
    const blockIds = new Set<string>();
    const blocks: SharedSurfaceBlock[] = [];
    const visit = (items: SharedSurfaceBlock[]) => {
      for (const block of items) {
        blocks.push(block);
        if (block.type === "section") visit(block.blocks);
      }
    };
    visit(doc.blocks);
    const nestedBlockCount = blocks.length - doc.blocks.length;
    if (nestedBlockCount > MAX_NESTED_BLOCKS)
      ctx.addIssue({
        code: "custom",
        message: "Surface supports at most 100 nested blocks",
      });
    if (doc.header?.status) blocks.push(doc.header.status);
    if (doc.header?.progress) blocks.push(doc.header.progress);
    if (doc.footer) {
      const footerActionIds = doc.footer.actions.map((action) => action.id);
      if (new Set(footerActionIds).size !== footerActionIds.length)
        ctx.addIssue({
          code: "custom",
          message: "Duplicate action id in footer",
        });
    }
    for (const block of blocks) {
      if (block.id === SURFACE_FOOTER_BLOCK_ID || block.id === "header")
        ctx.addIssue({
          code: "custom",
          message: `Block id "${block.id}" is reserved for the document slot`,
        });
      if (blockIds.has(block.id))
        ctx.addIssue({
          code: "custom",
          message: `Duplicate block id: ${block.id}`,
        });
      blockIds.add(block.id);
      if (block.type === "progress" && block.value > block.max)
        ctx.addIssue({
          code: "custom",
          message: `Progress ${block.id} value exceeds max`,
        });
      const childIds =
        block.type === "list"
          ? block.items.map((x) => x.id)
          : block.type === "table"
            ? [
                ...block.columns.map((x) => x.id),
                ...block.rows.map((x) => x.id),
              ]
            : block.type === "section"
              ? (block.actions ?? []).map((x) => x.id)
              : block.type === "form"
                ? [...block.fields.map((x) => x.id), block.submit.id]
                : [];
      if (new Set(childIds).size !== childIds.length)
        ctx.addIssue({
          code: "custom",
          message: `Duplicate child id in block ${block.id}`,
        });
      if (block.type === "list" || block.type === "table") {
        const entries = block.type === "list" ? block.items : block.rows;
        for (const entry of entries) {
          const actionIds = (entry.actions ?? []).map((action) => action.id);
          if (new Set(actionIds).size !== actionIds.length)
            ctx.addIssue({
              code: "custom",
              message: `Duplicate action id in item ${entry.id} of block ${block.id}`,
            });
        }
      }
      if (block.type === "table") {
        const primaryCount = block.columns.filter(
          (column) => column.priority !== "secondary"
        ).length;
        if (primaryCount > MAX_PRIMARY_TABLE_COLUMNS)
          ctx.addIssue({
            code: "custom",
            message: `Table ${block.id} allows at most ${MAX_PRIMARY_TABLE_COLUMNS} primary columns at the 400px rail; mark the rest priority: "secondary" (they collapse behind a per-row disclosure)`,
          });
        for (const column of block.columns)
          if (column.badgeVariants && column.format !== "badge")
            ctx.addIssue({
              code: "custom",
              message: `badgeVariants requires badge format in column ${column.id}`,
            });
        const columnIds = new Set(block.columns.map((column) => column.id));
        for (const row of block.rows)
          for (const key of Object.keys(row.cells))
            if (!columnIds.has(key))
              ctx.addIssue({
                code: "custom",
                message: `Unknown table column ${key} in row ${row.id}`,
              });
        for (const column of block.columns) {
          if (column.format !== "url") continue;
          for (const row of block.rows) {
            const value = row.cells[column.id];
            if (
              value !== undefined &&
              value !== null &&
              !isAllowedTableUrl(value)
            )
              ctx.addIssue({
                code: "custom",
                message: `URL cell ${column.id} in row ${row.id} must use http, https, or mailto`,
              });
          }
        }
      }
      if (block.type === "form") {
        for (const field of block.fields) {
          if (
            (field.type === "text" || field.type === "textarea") &&
            field.minLength !== undefined &&
            field.maxLength !== undefined &&
            field.minLength > field.maxLength
          )
            ctx.addIssue({
              code: "custom",
              message: `${field.id} minLength exceeds maxLength`,
            });
          if (
            field.type === "number" &&
            field.min !== undefined &&
            field.max !== undefined &&
            field.min > field.max
          )
            ctx.addIssue({
              code: "custom",
              message: `${field.id} min exceeds max`,
            });
          if (field.type === "select" || field.type === "radio") {
            const values = field.options.map((option) => option.value);
            if (new Set(values).size !== values.length)
              ctx.addIssue({
                code: "custom",
                message: `Duplicate option value in field ${field.id}`,
              });
            const defaults = Array.isArray(field.defaultValue)
              ? field.defaultValue
              : field.defaultValue === undefined
                ? []
                : [field.defaultValue];
            if (
              defaults.some(
                (value) =>
                  !field.options.some((option) => option.value === value)
              )
            )
              ctx.addIssue({
                code: "custom",
                message: `Invalid default option in field ${field.id}`,
              });
            if (
              field.type === "select" &&
              !field.multiple &&
              Array.isArray(field.defaultValue)
            )
              ctx.addIssue({
                code: "custom",
                message: `${field.id} defaultValue must be a string`,
              });
          }
        }
      }
    }
  });

type IsAny<Value> = 0 extends 1 & Value ? true : false;
declare const anyType: unique symbol;
type AnyType = { readonly [anyType]: "any" };
type Flat<Value> =
  IsAny<Value> extends true
    ? AnyType
    : Value extends readonly (infer Item)[]
      ? Flat<Item>[]
      : Value extends object
        ? { [Key in keyof Value]: Flat<Value[Key]> }
        : Value;
type Equal<Left, Right> =
  IsAny<Left> extends true
    ? IsAny<Right>
    : IsAny<Right> extends true
      ? false
      : (<Value>() => Value extends Flat<Left> ? 1 : 2) extends <
            Value,
          >() => Value extends Flat<Right> ? 1 : 2
        ? (<Value>() => Value extends Flat<Right> ? 1 : 2) extends <
            Value,
          >() => Value extends Flat<Left> ? 1 : 2
          ? true
          : false
        : false;
type Assert<Condition extends true> = Condition;
type AssertFalse<Condition extends false> = Condition;

export type SurfaceBlockContractMatches = Assert<
  Equal<z.infer<typeof surfaceBlockSchema>, SharedSurfaceBlock>
>;
export type SurfaceDocumentContractMatches = Assert<
  Equal<z.infer<typeof surfaceDocumentSchema>, SharedSurfaceDocumentInput>
>;

export type SurfaceBlock = SharedSurfaceBlock;
export type SurfaceDocumentInput = SharedSurfaceDocumentInput;
export type { SurfaceIcon, SurfaceLifecycle };
export type InteractionStatus = SurfaceInteractionStatus;

export const interactionRequestSchema = z.discriminatedUnion("kind", [
  z
    .object({
      idempotencyKey: z.string().min(1).max(200),
      kind: z.literal("action"),
      blockId: idSchema,
      actionId: idSchema,
      itemId: idSchema.optional(),
      baseRevision: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      idempotencyKey: z.string().min(1).max(200),
      kind: z.literal("form_submit"),
      blockId: idSchema,
      actionId: idSchema,
      values: z.record(
        z.string(),
        z.union([scalarSchema, z.array(z.string()).max(50)])
      ),
      baseRevision: z.number().int().positive(),
    })
    .strict(),
]);
export type InteractionRequestContractMatches = Assert<
  Equal<z.infer<typeof interactionRequestSchema>, SurfaceInteractionRequest>
>;
export type InteractionRequest = SurfaceInteractionRequest;

// Compile-time drift fixtures: these must remain observably different from the
// shared wire types, including optional-property and nested `any` degradation.
type OptionalDocumentTitleDrift = Omit<SharedSurfaceDocumentInput, "title"> & {
  title?: string;
};
type OptionalBlockIdDrift = SharedSurfaceBlock extends infer Block
  ? Block extends { id: string }
    ? Omit<Block, "id"> & { id?: string }
    : never
  : never;
type AnyInteractionRevisionDrift =
  SurfaceInteractionRequest extends infer Request
    ? Request extends { baseRevision: number }
      ? Omit<Request, "baseRevision"> & { baseRevision: any }
      : never
    : never;
export type OptionalDocumentDriftIsRejected = AssertFalse<
  Equal<OptionalDocumentTitleDrift, SharedSurfaceDocumentInput>
>;
export type OptionalBlockDriftIsRejected = AssertFalse<
  Equal<OptionalBlockIdDrift, SharedSurfaceBlock>
>;
export type AnyInteractionDriftIsRejected = AssertFalse<
  Equal<AnyInteractionRevisionDrift, SurfaceInteractionRequest>
>;
