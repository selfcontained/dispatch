/*
 * A small structural schema language. Each schema is both a validator and a
 * printable shape, so request and response types, their validators and the
 * committed surface snapshot all come from one definition.
 *
 * Validators are structural only: they check kinds, never sizes, counts or
 * character sets. Limits belong to the caller (`too_large`) and to the
 * transport decoder of a particular wire, never to the contract.
 * Objects accept additional fields, as wire v1 peers do.
 */

export type Shape =
  | string
  | { literal: (string | number | boolean | null)[] }
  | { nullable: Shape }
  | { array: Shape }
  | { record: Shape }
  | { union: Shape[] }
  | { object: Record<string, Shape | { optional: Shape }> }
  | { opaque: string };

export interface Schema<T> {
  readonly shape: Shape;
  check(value: unknown): value is T;
}

export type Infer<S> = S extends Schema<infer T> ? T : never;

/** A JSON value passed through without interpretation (for example a raw ACP update). */
export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

const schema = <T>(
  shape: Shape,
  check: (value: unknown) => boolean
): Schema<T> => ({ shape, check: check as (value: unknown) => value is T });

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const string = schema<string>("string", (v) => typeof v === "string");
export const number = schema<number>(
  "number",
  (v) => typeof v === "number" && Number.isFinite(v)
);
export const integer = schema<number>(
  "integer",
  (v) => typeof v === "number" && Number.isSafeInteger(v)
);
export const boolean = schema<boolean>(
  "boolean",
  (v) => typeof v === "boolean"
);
export const json = schema<Json>("json", (v) => {
  try {
    return v !== undefined && JSON.stringify(v) !== undefined;
  } catch {
    return false;
  }
});

export function literal<const L extends (string | number | boolean | null)[]>(
  ...values: L
): Schema<L[number]> {
  return schema({ literal: values }, (v) => values.includes(v as L[number]));
}

export function nullable<T>(inner: Schema<T>): Schema<T | null> {
  return schema({ nullable: inner.shape }, (v) => v === null || inner.check(v));
}

export function array<T>(item: Schema<T>): Schema<T[]> {
  return schema(
    { array: item.shape },
    (v) => Array.isArray(v) && v.every((entry) => item.check(entry))
  );
}

export function record<T>(value: Schema<T>): Schema<Record<string, T>> {
  return schema(
    { record: value.shape },
    (v) => isObject(v) && Object.values(v).every((entry) => value.check(entry))
  );
}

export function union<S extends Schema<unknown>[]>(
  ...options: S
): Schema<Infer<S[number]>> {
  return schema({ union: options.map((option) => option.shape) }, (v) =>
    options.some((option) => option.check(v))
  );
}

/** Marks an object field that may be absent. */
export type Optional<T> = { readonly optional: Schema<T> };
export const optional = <T>(inner: Schema<T>): Optional<T> => ({
  optional: inner,
});

type Field = Schema<unknown> | Optional<unknown>;
type Fields = Record<string, Field>;
type Simplify<T> = { [K in keyof T]: T[K] } & {};
type RequiredKeys<F extends Fields> = {
  [K in keyof F]: F[K] extends Optional<unknown> ? never : K;
}[keyof F];
type OptionalKeys<F extends Fields> = Exclude<keyof F, RequiredKeys<F>>;
export type InferObject<F extends Fields> = Simplify<
  { [K in RequiredKeys<F>]: Infer<F[K]> } & {
    [K in OptionalKeys<F>]?: F[K] extends Optional<infer T> ? T : never;
  }
>;

export function object<const F extends Fields>(
  fields: F
): Schema<InferObject<F>> {
  const shape: Record<string, Shape | { optional: Shape }> = {};
  for (const [key, field] of Object.entries(fields))
    shape[key] =
      "optional" in field ? { optional: field.optional.shape } : field.shape;
  return schema({ object: shape }, (v) => {
    if (!isObject(v)) return false;
    return Object.entries(fields).every(([key, field]) =>
      "optional" in field
        ? v[key] === undefined || field.optional.check(v[key])
        : field.check(v[key])
    );
  });
}

/** The empty request or response. */
export const empty = object({});
