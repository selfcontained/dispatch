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

  return (
    <div
      className={cn("flex min-w-0 flex-col gap-1.5", className)}
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
        <div id={hintId} className="text-body-sm text-muted-foreground">
          {hint}
        </div>
      ) : null}
      {error ? <FieldError id={errorId}>{error}</FieldError> : null}
    </div>
  );
}
