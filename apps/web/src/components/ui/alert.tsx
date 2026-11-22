import {
  CircleCheck,
  Info,
  OctagonX,
  TriangleAlert,
  X,
  type LucideIcon,
} from "lucide-react";
import * as React from "react";

import { errorMessage, failureHint } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { Button } from "./button";
import { ErrorDetails } from "./error-details";
import { IconButton } from "./icon-button";

type AlertTone = "danger" | "warning" | "success" | "info";

const TONES: Record<
  AlertTone,
  { Icon: LucideIcon; box: string; text: string }
> = {
  danger: {
    Icon: OctagonX,
    box: "border-danger/line bg-danger/tint",
    text: "text-danger",
  },
  warning: {
    Icon: TriangleAlert,
    box: "border-warning/line bg-warning/tint",
    text: "text-warning-ink",
  },
  success: {
    Icon: CircleCheck,
    box: "border-success/line bg-success/tint",
    text: "text-success-ink",
  },
  info: {
    Icon: Info,
    box: "border-info/line bg-info/tint",
    text: "text-info-ink",
  },
};

export type AlertAction = {
  label: string;
  onClick: () => void;
  pending?: boolean;
  disabled?: boolean;
};

export interface AlertProps extends Omit<
  React.HTMLAttributes<HTMLDivElement>,
  "title"
> {
  tone?: AlertTone;
  /** A sentence. An error reads "Couldn’t <do the thing>." */
  title: React.ReactNode;
  /** The failure. Its message goes behind Details, and sets the next step. */
  error?: unknown;
  action?: AlertAction;
  secondaryAction?: AlertAction;
  onDismiss?: () => void;
}

/** A condition of the view that stays until it is resolved. */
export const Alert = React.forwardRef<HTMLDivElement, AlertProps>(
  (
    {
      tone = "danger",
      title,
      error,
      action,
      secondaryAction,
      onDismiss,
      className,
      children,
      ...props
    },
    ref
  ) => {
    const { Icon, box, text } = TONES[tone];
    const body = children ?? (error ? failureHint(error) : null);
    const actionButton = (
      { label, onClick, pending, disabled }: AlertAction,
      variant: "primary" | "ghost"
    ) => (
      <Button
        type="button"
        size="sm"
        variant={variant}
        pending={pending}
        disabled={disabled}
        onClick={onClick}
      >
        {label}
      </Button>
    );

    return (
      <div
        ref={ref}
        role={tone === "danger" ? "alert" : "status"}
        className={cn(
          "flex min-w-0 shrink-0 items-start gap-2 rounded-md border px-3 py-2 text-left text-body-sm",
          box,
          className
        )}
        {...props}
      >
        <Icon
          aria-hidden="true"
          className={cn("mt-0.5 size-icon-md shrink-0", text)}
        />
        <div className="min-w-0 flex-1 space-y-1">
          <p className={cn("break-words font-medium", text)}>{title}</p>
          {body ? (
            <div className="break-words text-foreground">{body}</div>
          ) : null}
          {error ? <ErrorDetails message={errorMessage(error)} /> : null}
          {action || secondaryAction ? (
            <div className="flex flex-wrap gap-2 pt-1">
              {action ? actionButton(action, "primary") : null}
              {secondaryAction ? actionButton(secondaryAction, "ghost") : null}
            </div>
          ) : null}
        </div>
        {onDismiss ? (
          <IconButton
            size="icon-sm"
            label="Dismiss"
            className="-my-1 -mr-2"
            onClick={onDismiss}
          >
            <X />
          </IconButton>
        ) : null}
      </div>
    );
  }
);
Alert.displayName = "Alert";
