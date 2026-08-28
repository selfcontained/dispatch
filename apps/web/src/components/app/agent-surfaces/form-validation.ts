/**
 * Pure form-value defaults/validation, split out from form-block.tsx so it
 * can be unit tested without React.
 */
import type { FormField, Scalar } from "@/components/app/agent-surfaces/types";

export type FormFieldValue = Scalar | string[];
export type FormValues = Record<string, FormFieldValue>;

export function defaultFormValues(fields: readonly FormField[]): FormValues {
  const values: FormValues = {};
  for (const field of fields) {
    if (field.type === "checkbox") {
      values[field.id] = field.defaultValue ?? false;
    } else if (field.type === "number") {
      values[field.id] = field.defaultValue ?? null;
    } else if (field.type === "select" && field.multiple) {
      values[field.id] = field.defaultValue ?? [];
    } else {
      values[field.id] = field.defaultValue ?? "";
    }
  }
  return values;
}

/** Fills in defaults for any field the stored draft predates (e.g. the agent
 * added a field since the draft was last saved). */
export function mergeFormValues(
  fields: readonly FormField[],
  draft: FormValues | null
): FormValues {
  return { ...defaultFormValues(fields), ...(draft ?? {}) };
}

function isEmpty(field: FormField, value: FormFieldValue | undefined): boolean {
  if (field.type === "checkbox") return value !== true;
  if (Array.isArray(value)) return value.length === 0;
  return value === undefined || value === null || value === "";
}

export function validateFormValues(
  fields: readonly FormField[],
  values: FormValues
): Record<string, string> {
  const errors: Record<string, string> = {};

  for (const field of fields) {
    const value = values[field.id];

    if (field.required && isEmpty(field, value)) {
      errors[field.id] = "Required";
      continue;
    }

    if (
      (field.type === "text" || field.type === "textarea") &&
      typeof value === "string" &&
      value.length > 0
    ) {
      if (field.minLength != null && value.length < field.minLength) {
        errors[field.id] = `Must be at least ${field.minLength} characters`;
      } else if (field.maxLength != null && value.length > field.maxLength) {
        errors[field.id] = `Must be at most ${field.maxLength} characters`;
      }
    }

    if (field.type === "number" && typeof value === "number") {
      if (field.min != null && value < field.min) {
        errors[field.id] = `Must be at least ${field.min}`;
      } else if (field.max != null && value > field.max) {
        errors[field.id] = `Must be at most ${field.max}`;
      }
    }
  }

  return errors;
}
