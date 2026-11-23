import * as React from "react";

import { cn } from "@/lib/utils";
import { FieldContext, type FieldControl } from "./field-context";

export function FieldError({
  className,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>): JSX.Element {
  return (
    <p
      role="alert"
      className={cn("break-words text-body-sm text-danger", className)}
      {...props}
    />
  );
}

export interface FieldProps {
  label: React.ReactNode;
  /** The label is read but not shown. */
  labelHidden?: boolean;
  /** Sits beside the label, outside it: a help button, a character count. */
  labelAction?: React.ReactNode;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  optional?: boolean;
  required?: boolean;
  /** Several controls under one label, such as a list of choices. */
  group?: boolean;
  /**
   * "responsive": label above, or to the left once the nearest container
   * (`[container-type:inline-size]`) is 640px wide.
   */
  layout?: "stacked" | "responsive";
  /** The control's id, where it needs a fixed one. */
  id?: string;
  className?: string;
  children: React.ReactNode;
}

/** A label, its control, then help and error text. */
export function Field({
  label,
  labelHidden,
  labelAction,
  hint,
  error,
  optional,
  required,
  group,
  id,
  layout = "stacked",
  className,
  children,
}: FieldProps): JSX.Element {
  const generated = React.useId();
  const controlId = id ?? generated;
  const labelId = `${controlId}-label`;
  const hintId = `${controlId}-hint`;
  const errorId = `${controlId}-error`;
  const describedBy =
    [error && errorId, hint && hintId].filter(Boolean).join(" ") || undefined;
  const invalid = Boolean(error);
  const control = React.useMemo<FieldControl>(
    () => ({ id: controlId, describedBy, invalid, required }),
    [controlId, describedBy, invalid, required]
  );
  const Label = group ? "span" : "label";
  const responsive = layout === "responsive";
  const aside = responsive && "block-wide:col-start-2";

  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-1.5",
        responsive &&
          "block-wide:grid block-wide:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] block-wide:gap-x-3",
        className
      )}
      {...(group
        ? {
            role: "group",
            "aria-labelledby": labelId,
            "aria-describedby": describedBy,
          }
        : {})}
    >
      <div
        className={cn(
          "flex min-h-4 items-center gap-1",
          responsive && "block-wide:min-h-7 block-wide:self-start",
          labelHidden && "sr-only"
        )}
      >
        <Label
          id={labelId}
          htmlFor={group ? undefined : controlId}
          className="text-body-sm font-medium text-foreground"
        >
          {label}
          {optional ? (
            <span className="font-normal text-muted-foreground">
              {" "}
              (optional)
            </span>
          ) : null}
          {required ? (
            <span aria-hidden="true" className="text-danger">
              {" "}
              *
            </span>
          ) : null}
        </Label>
        {labelAction}
      </div>
      <FieldContext.Provider value={group ? null : control}>
        {children}
      </FieldContext.Provider>
      {hint ? (
        <div
          id={hintId}
          className={cn("text-body-sm text-muted-foreground", aside)}
        >
          {hint}
        </div>
      ) : null}
      {error ? (
        <FieldError id={errorId} className={cn(aside)}>
          {error}
        </FieldError>
      ) : null}
    </div>
  );
}
