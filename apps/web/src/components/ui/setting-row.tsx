import * as React from "react";
import { Check } from "lucide-react";

import { cn } from "@/lib/utils";
import { Alert } from "./alert";
import { panelFrame } from "./card";
import { FieldError } from "./field";
import { FieldContext, type FieldControl } from "./field-context";

/** Where an auto-saved setting stands; see useAutoSave. */
export type SaveStatus = {
  state: "idle" | "saving" | "saved" | "failed";
  error?: unknown;
  retry?: () => void;
};

/** "Saved", briefly, once the server confirms. */
export function SavedNote({ status }: { status: SaveStatus }): JSX.Element {
  return (
    <span
      role="status"
      data-save-note=""
      className="inline-flex shrink-0 items-center gap-1 text-body-sm text-success-ink"
    >
      {status.state === "saved" ? (
        <>
          <Check aria-hidden="true" className="size-icon-sm" />
          Saved
        </>
      ) : null}
    </span>
  );
}

/** The one wording for a failed save, with Retry of what was intended. */
export function SaveFailure({
  status,
  className,
}: {
  status: SaveStatus;
  className?: string;
}): JSX.Element | null {
  // A retry in flight keeps the error it is retrying.
  if (!status.error || status.state === "saved") return null;
  return (
    <Alert
      title="Couldn’t save changes."
      error={status.error}
      className={className}
      action={
        status.retry
          ? {
              label: "Retry",
              onClick: status.retry,
              pending: status.state === "saving",
            }
          : undefined
      }
    />
  );
}

/**
 * - `toggle`: a Switch or Checkbox. The whole row toggles it.
 * - `field`: an Input or Select, right of its label; under it on a phone.
 * - `action`: buttons, or a control that names itself.
 * - `group`: a picker or list that needs the row's full width.
 */
type Layout = "toggle" | "field" | "action" | "group";

interface RowProps {
  label: React.ReactNode;
  description?: React.ReactNode;
  error?: React.ReactNode;
  /** An auto-saved setting's state: Saved, or the failure and Retry. */
  status?: SaveStatus;
  disabled?: boolean;
  /** The control’s id, where it needs a fixed one. */
  id?: string;
  /** The Switch, Checkbox or other control. */
  children?: React.ReactNode;
  /** What the setting reveals under itself. */
  details?: React.ReactNode;
  className?: string;
  "data-testid"?: string;
}

function ControlRow({
  label,
  description,
  error,
  status,
  disabled,
  id: fixedId,
  children,
  details,
  className,
  controlFirst,
  layout = "toggle",
  ...props
}: RowProps & { controlFirst?: boolean; layout?: Layout }): JSX.Element {
  const generated = React.useId();
  const id = fixedId ?? generated;
  const describedBy =
    [error && `${id}-error`, description && `${id}-description`]
      .filter(Boolean)
      .join(" ") || undefined;
  const invalid =
    Boolean(error) || (layout === "field" && Boolean(status?.error));
  const toggle = layout === "toggle";
  const grouped = layout === "group" || layout === "action";
  const control = React.useMemo<FieldControl | null>(
    () =>
      grouped
        ? null
        : {
            id,
            describedBy,
            // Where the label also holds the description, name it by the title.
            labelledBy: toggle ? `${id}-label` : undefined,
            invalid,
          },
    [grouped, toggle, id, describedBy, invalid]
  );

  const Title = layout === "field" ? "label" : "span";
  const text = (
    <span className={cn("min-w-0", disabled && "opacity-70")}>
      <span className="flex flex-wrap items-center gap-x-2">
        <Title
          id={`${id}-label`}
          htmlFor={layout === "field" ? id : undefined}
          className="min-w-0 break-words text-body-md font-medium text-foreground"
        >
          {label}
        </Title>
        {status ? <SavedNote status={status} /> : null}
      </span>
      {description ? (
        <span
          id={`${id}-description`}
          className="mt-0.5 block break-words text-body-sm text-muted-foreground"
        >
          {description}
        </span>
      ) : null}
    </span>
  );
  const controlled = (
    <FieldContext.Provider value={control}>{children}</FieldContext.Provider>
  );
  const controlNode = (
    <span className={cn("flex shrink-0", controlFirst && "pt-0.5")}>
      {controlled}
    </span>
  );

  return (
    <div
      className={cn(panelFrame, className)}
      role={grouped ? "group" : undefined}
      aria-labelledby={grouped ? `${id}-label` : undefined}
      aria-describedby={grouped ? describedBy : undefined}
      {...props}
    >
      {toggle ? (
        <label
          className={cn(
            "flex min-h-11 gap-3 rounded-lg px-3 py-3 transition-colors",
            controlFirst ? "items-start" : "items-center justify-between",
            disabled
              ? "cursor-not-allowed"
              : "cursor-pointer hover:bg-surface-hover"
          )}
        >
          {controlFirst ? controlNode : null}
          {text}
          {controlFirst ? null : controlNode}
        </label>
      ) : (
        <div
          className={cn(
            "flex min-h-11 min-w-0 flex-col gap-3 px-3 py-3",
            layout !== "group" &&
              "sm:flex-row sm:items-center sm:justify-between"
          )}
        >
          {text}
          {children ? (
            <div
              className={cn(
                "min-w-0",
                layout === "field" && "w-full sm:w-72 sm:shrink-0",
                layout === "action" &&
                  "flex max-w-full flex-wrap items-center gap-2 sm:shrink-0"
              )}
            >
              {controlled}
            </div>
          ) : null}
        </div>
      )}
      {error ? (
        <FieldError id={`${id}-error`} className="px-3 pb-3">
          {error}
        </FieldError>
      ) : null}
      {status ? <SaveFailure status={status} className="mx-3 mb-3" /> : null}
      {details ? <div className="px-3 pb-3">{details}</div> : null}
    </div>
  );
}

/** A setting: what it is on the left, its control on the right. */
export function SettingRow(props: RowProps & { layout?: Layout }): JSX.Element {
  return <ControlRow {...props} />;
}

/** A choice in a multi-select or a form: the checkbox, then what it means. */
export function OptionCard(props: RowProps): JSX.Element {
  return <ControlRow controlFirst {...props} />;
}
