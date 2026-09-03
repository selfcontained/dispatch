import type { ReactNode } from "react";

import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { FormField, Scalar } from "@/components/app/agent-surfaces/types";
import { ChoiceOptionRow } from "@/components/app/agent-surfaces/blocks/choice-option";

export type FormFieldValue = Scalar | string[];

function FieldShell({
  field,
  fieldId,
  error,
  children,
}: {
  field: FormField;
  fieldId: string;
  error?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="space-y-1">
      <label
        id={`${fieldId}-label`}
        htmlFor={fieldId}
        className="block text-xs font-medium text-foreground"
      >
        {field.label}
        {field.required ? (
          // Muted, not danger-colored: a required marker is not an error
          // state, and five red glyphs down a form read as five failures.
          <span aria-hidden="true" className="text-muted-foreground">
            {" "}
            *
          </span>
        ) : null}
      </label>
      {field.description ? (
        <p className="text-[11px] text-muted-foreground">{field.description}</p>
      ) : null}
      {children}
      {error ? (
        <p role="alert" className="text-[11px] text-status-blocked">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Exhaustiveness guard for the switch below — a compile error here means a
 * new `FormField.type` was added without a matching case. */
function assertNever(field: never): never {
  throw new Error(`Unhandled FormField type: ${JSON.stringify(field)}`);
}

export function FormFieldControl({
  field,
  fieldId,
  value,
  onChange,
  error,
}: {
  field: FormField;
  fieldId: string;
  value: FormFieldValue | undefined;
  onChange: (value: FormFieldValue) => void;
  error?: string;
}): JSX.Element {
  switch (field.type) {
    case "text":
    case "textarea":
      return (
        <FieldShell field={field} fieldId={fieldId} error={error}>
          {field.type === "textarea" ? (
            <Textarea
              id={fieldId}
              value={typeof value === "string" ? value : ""}
              placeholder={field.placeholder}
              minLength={field.minLength}
              maxLength={field.maxLength}
              required={field.required}
              aria-invalid={!!error}
              onChange={(e) => onChange(e.target.value)}
            />
          ) : (
            <Input
              id={fieldId}
              value={typeof value === "string" ? value : ""}
              placeholder={field.placeholder}
              minLength={field.minLength}
              maxLength={field.maxLength}
              required={field.required}
              aria-invalid={!!error}
              onChange={(e) => onChange(e.target.value)}
            />
          )}
        </FieldShell>
      );

    case "number":
      return (
        <FieldShell field={field} fieldId={fieldId} error={error}>
          <Input
            id={fieldId}
            type="number"
            value={typeof value === "number" ? value : ""}
            min={field.min}
            max={field.max}
            step={field.step}
            required={field.required}
            aria-invalid={!!error}
            onChange={(e) =>
              onChange(e.target.value === "" ? null : Number(e.target.value))
            }
          />
        </FieldShell>
      );

    case "checkbox":
      return (
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Checkbox
              id={fieldId}
              checked={typeof value === "boolean" ? value : false}
              aria-invalid={!!error}
              onCheckedChange={(checked) => onChange(checked === true)}
            />
            <label
              htmlFor={fieldId}
              className="text-xs font-medium text-foreground"
            >
              {field.label}
              {field.required ? (
                // Muted like FieldShell's marker — required is not an error.
                <span aria-hidden="true" className="text-muted-foreground">
                  {" "}
                  *
                </span>
              ) : null}
            </label>
          </div>
          {field.description ? (
            <p className="pl-7 text-[11px] text-muted-foreground">
              {field.description}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="pl-7 text-[11px] text-status-blocked">
              {error}
            </p>
          ) : null}
        </div>
      );

    case "radio":
      return (
        <FieldShell field={field} fieldId={fieldId} error={error}>
          <div
            role="radiogroup"
            aria-labelledby={`${fieldId}-label`}
            className="space-y-1.5"
          >
            {field.options.map((option) => {
              const optionId = `${fieldId}-${option.value}`;
              return (
                <ChoiceOptionRow
                  key={option.value}
                  option={option}
                  optionId={optionId}
                  control={
                    <input
                      type="radio"
                      id={optionId}
                      name={fieldId}
                      value={option.value}
                      disabled={option.disabled}
                      checked={value === option.value}
                      onChange={() => onChange(option.value)}
                      className="h-4 w-4 shrink-0 accent-primary"
                    />
                  }
                />
              );
            })}
          </div>
        </FieldShell>
      );

    case "select": {
      if (field.multiple) {
        const selected = Array.isArray(value) ? value : [];
        return (
          <FieldShell field={field} fieldId={fieldId} error={error}>
            <div
              role="group"
              aria-labelledby={`${fieldId}-label`}
              className="space-y-1.5"
            >
              {field.options.map((option) => {
                const optionId = `${fieldId}-${option.value}`;
                const checked = selected.includes(option.value);
                return (
                  <ChoiceOptionRow
                    key={option.value}
                    option={option}
                    optionId={optionId}
                    control={
                      <Checkbox
                        id={optionId}
                        checked={checked}
                        disabled={option.disabled}
                        className="h-4 w-4"
                        onCheckedChange={(next) =>
                          onChange(
                            next === true
                              ? [...selected, option.value]
                              : selected.filter((v) => v !== option.value)
                          )
                        }
                      />
                    }
                  />
                );
              })}
            </div>
          </FieldShell>
        );
      }

      return (
        <FieldShell field={field} fieldId={fieldId} error={error}>
          <Select
            value={typeof value === "string" ? value : undefined}
            onValueChange={(next) => onChange(next)}
          >
            <SelectTrigger
              id={fieldId}
              aria-invalid={!!error}
              className={cn(error && "ring-1 ring-status-blocked")}
            >
              <SelectValue placeholder="Select…" />
            </SelectTrigger>
            <SelectContent>
              {field.options.map((option) => (
                <SelectItem
                  key={option.value}
                  value={option.value}
                  disabled={option.disabled}
                >
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FieldShell>
      );
    }

    default:
      return assertNever(field);
  }
}
