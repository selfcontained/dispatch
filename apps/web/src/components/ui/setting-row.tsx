import * as React from "react";

import { cn } from "@/lib/utils";
import { FieldError } from "./field";
import { FieldContext, type FieldControl } from "./field-context";

interface RowProps {
  label: React.ReactNode;
  description?: React.ReactNode;
  error?: React.ReactNode;
  disabled?: boolean;
  /** The Switch, Checkbox or other control. */
  children: React.ReactNode;
  /** What the setting reveals under itself. */
  details?: React.ReactNode;
  className?: string;
  "data-testid"?: string;
}

function ControlRow({
  label,
  description,
  error,
  disabled,
  children,
  details,
  className,
  controlFirst,
  ...props
}: RowProps & { controlFirst?: boolean }): JSX.Element {
  const id = React.useId();
  const describedBy =
    [error && `${id}-error`, description && `${id}-description`]
      .filter(Boolean)
      .join(" ") || undefined;
  const invalid = Boolean(error);
  const control = React.useMemo<FieldControl>(
    () => ({ id, describedBy, labelledBy: `${id}-label`, invalid }),
    [id, describedBy, invalid]
  );
  const controlNode = (
    <span className={cn("flex shrink-0", controlFirst && "pt-0.5")}>
      <FieldContext.Provider value={control}>{children}</FieldContext.Provider>
    </span>
  );

  return (
    <div
      className={cn(
        "min-w-0 rounded-md border border-border-subtle bg-surface-subtle",
        className
      )}
      {...props}
    >
      <label
        className={cn(
          "flex min-h-11 gap-3 rounded-md px-3 py-3 transition-colors",
          controlFirst ? "items-start" : "items-center justify-between",
          disabled
            ? "cursor-not-allowed"
            : "cursor-pointer hover:bg-surface-hover"
        )}
      >
        {controlFirst ? controlNode : null}
        <span className={cn("min-w-0", disabled && "opacity-70")}>
          <span
            id={`${id}-label`}
            className="block text-body-md font-medium text-foreground"
          >
            {label}
          </span>
          {description ? (
            <span
              id={`${id}-description`}
              className="mt-0.5 block text-body-sm text-muted-foreground"
            >
              {description}
            </span>
          ) : null}
        </span>
        {controlFirst ? null : controlNode}
      </label>
      {error ? (
        <FieldError id={`${id}-error`} className="px-3 pb-3">
          {error}
        </FieldError>
      ) : null}
      {details ? <div className="px-3 pb-3">{details}</div> : null}
    </div>
  );
}

/** A setting: what it is on the left, its control on the right. */
export function SettingRow(props: RowProps): JSX.Element {
  return <ControlRow {...props} />;
}

/** A choice in a form that has a Save: the checkbox, then what it means. */
export function OptionCard(props: RowProps): JSX.Element {
  return <ControlRow controlFirst {...props} />;
}
