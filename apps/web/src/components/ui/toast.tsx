import {
  CircleCheck,
  Info,
  OctagonX,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import * as React from "react";
// The only import of sonner: everything else goes through this module.
import { toast as sonner, Toaster } from "sonner";

import { errorMessage, failureHint } from "@/lib/errors";
import { cn } from "@/lib/utils";
import {
  TOAST_PRIORITY,
  ToastStack,
  type StackedToast,
} from "@/lib/toast-stack";
import { Button } from "./button";
import { ErrorDetails } from "./error-details";
import { ToastCard } from "./toast-card";

type StatusKind = "success" | "error" | "info" | "warning";

const STATUS: Record<
  StatusKind,
  {
    label: string;
    Icon: LucideIcon;
    text: string;
    duration: number;
    tone: { border: string; bar: string; tile: string };
  }
> = {
  success: {
    label: "Success",
    Icon: CircleCheck,
    text: "text-success-ink",
    duration: 4000,
    tone: {
      border: "border-success/line-strong",
      bar: "bg-success",
      tile: "bg-success",
    },
  },
  info: {
    label: "Info",
    Icon: Info,
    text: "text-info-ink",
    duration: 4000,
    tone: {
      border: "border-info/line-strong",
      bar: "bg-info",
      tile: "bg-info",
    },
  },
  warning: {
    label: "Warning",
    Icon: TriangleAlert,
    text: "text-warning-ink",
    duration: 12_000,
    tone: {
      border: "border-warning/line-strong",
      bar: "bg-warning",
      tile: "bg-warning",
    },
  },
  error: {
    label: "Error",
    Icon: OctagonX,
    text: "text-danger",
    duration: 12_000,
    tone: {
      border: "border-danger/line-strong",
      bar: "bg-danger",
      tile: "bg-danger",
    },
  },
};

export type ToastAction = {
  label: string;
  /** preventDefault() keeps the toast up. */
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
};

export type ToastOptions = {
  id?: string;
  /** A plain reason or next step. An `error` supplies one if this is absent. */
  description?: React.ReactNode;
  /** The failure. Its message goes behind Details. */
  error?: unknown;
  duration?: number;
  icon?: LucideIcon;
  /** The primary button. */
  action?: ToastAction;
  /** The ghost button. */
  cancel?: ToastAction;
  /** The person dismissed it: not a timeout, nor `toast.dismiss`. */
  onDismiss?: () => void;
};

interface Entry extends StackedToast {
  id: string;
  duration: number;
  render: () => React.ReactElement;
  onDismiss?: () => void;
}

// A shown id maps to a key of its own, so showing it again straight after a
// dismissal can't be caught by the dismissal that is still landing.
const live = new Map<string, string>();
let sequence = 0;

const stack = new ToastStack<Entry>(display, (entry) => {
  forget(entry);
  sonner.dismiss(entry.key);
});

function isLive(entry: Entry): boolean {
  return live.get(entry.id) === entry.key;
}

function forget(entry: Entry): void {
  if (isLive(entry)) live.delete(entry.id);
}

function display(entry: Entry): void {
  // Sonner calls onDismiss for its own swipe and for every dismiss(), so
  // anything still live by then was dismissed by the person.
  sonner.custom(entry.render, {
    id: entry.key,
    duration: entry.duration,
    onAutoClose: () => {
      if (!isLive(entry)) return;
      forget(entry);
      stack.remove(entry.key);
    },
    onDismiss: () => {
      if (!isLive(entry)) return;
      forget(entry);
      stack.remove(entry.key);
      entry.onDismiss?.();
    },
  });
}

function push(
  id: string | undefined,
  build: (entry: { id: string; key: string }) => Omit<Entry, "id" | "key">
): string {
  sequence += 1;
  const publicId = id ?? `toast-${sequence}`;
  const key = live.get(publicId) ?? `${publicId}:${sequence}`;
  live.set(publicId, key);
  stack.push({ id: publicId, key, ...build({ id: publicId, key }) });
  return publicId;
}

/** Closes it from code, or after one of its own actions. */
function dismiss(id?: string): void {
  if (id === undefined) {
    for (const entry of stack.clear()) {
      forget(entry);
      sonner.dismiss(entry.key);
    }
    return;
  }
  const key = live.get(id);
  if (!key) return;
  live.delete(id);
  sonner.dismiss(key);
  stack.remove(key);
}

function status(kind: StatusKind) {
  return (title: React.ReactNode, options: ToastOptions = {}): string => {
    const duration = options.duration ?? STATUS[kind].duration;
    const holds =
      kind === "error" || kind === "warning" || duration === Infinity;
    return push(options.id, ({ id, key }) => {
      const entry: Omit<Entry, "id" | "key"> = {
        priority: holds ? TOAST_PRIORITY.holds : TOAST_PRIORITY.passing,
        duration,
        onDismiss: options.onDismiss,
        render: () => (
          <StatusToast
            kind={kind}
            title={title}
            options={options}
            onClose={() => dismiss(id)}
            onUserClose={() => {
              dismiss(id);
              options.onDismiss?.();
            }}
            // Sonner measures a toast only when it is given again.
            onResize={() => {
              if (live.get(id) === key) display({ id, key, ...entry });
            }}
          />
        ),
      };
      return entry;
    });
  };
}

/**
 * `success` and `info` for a completed action whose result isn't on screen;
 * `error` and `warning` for background work that failed. A failure on what
 * is on screen is an inline Alert instead.
 */
export const toast = {
  success: status("success"),
  error: status("error"),
  info: status("info"),
  warning: status("warning"),
  /** An attention card, which Notifications also keeps. */
  attention: (
    render: () => React.ReactElement,
    options: { id: string; duration: number }
  ): string =>
    push(options.id, () => ({
      priority: TOAST_PRIORITY.attention,
      duration: options.duration,
      render,
    })),
  dismiss,
};

function StatusToast({
  kind,
  title,
  options,
  onClose,
  onUserClose,
  onResize,
}: {
  kind: StatusKind;
  title: React.ReactNode;
  options: ToastOptions;
  onClose: () => void;
  onUserClose: () => void;
  onResize: () => void;
}): JSX.Element {
  const { label, Icon, text, tone } = STATUS[kind];
  const { error, action, cancel } = options;
  const description =
    options.description ?? (error ? failureHint(error) : null);
  const button = (
    { label: name, onClick }: ToastAction,
    variant: "primary" | "ghost"
  ) => (
    <Button
      type="button"
      size="sm"
      variant={variant}
      onClick={(event) => {
        onClick(event);
        if (!event.defaultPrevented) onClose();
      }}
    >
      {name}
    </Button>
  );
  return (
    <ToastCard
      Icon={options.icon ?? Icon}
      tone={tone}
      onDismiss={onUserClose}
      bodyProps={{ "data-testid": "status-toast", "data-kind": kind }}
    >
      <div className="min-w-0 flex-1 space-y-1">
        <p className={cn("section-label", text)}>{label}</p>
        <p className="break-words text-body-md font-semibold">{title}</p>
        {description ? (
          <p className="break-words text-body-sm text-muted-foreground">
            {description}
          </p>
        ) : null}
        {error ? (
          <ErrorDetails message={errorMessage(error)} onToggle={onResize} />
        ) : null}
        {action || cancel ? (
          <div className="flex flex-wrap gap-2 pt-1">
            {action ? button(action, "primary") : null}
            {cancel ? button(cancel, "ghost") : null}
          </div>
        ) : null}
      </div>
    </ToastCard>
  );
}

/**
 * The one host: top right on desktop, top and inset on a phone, where it
 * follows the visible top so it never reaches the composer. Always expanded,
 * so nothing sits behind another toast.
 */
export function ToastHost({ isMobile }: { isMobile: boolean }): JSX.Element {
  React.useEffect(() => () => dismiss(), []);
  const mobileTop = "calc(var(--safe-area-top) + var(--vv-top, 0px) + 0.5rem)";
  const inset = { top: mobileTop, left: "0.5rem", right: "0.5rem" };
  return (
    <Toaster
      position={isMobile ? "top-center" : "top-right"}
      expand
      // One more than the stack holds, so a toast on its way out can't hide
      // the oldest one staying.
      visibleToasts={4}
      className="dispatch-toaster"
      offset={
        isMobile
          ? inset
          : // Below the top inset band (iPad), which #safe-area-top covers.
            {
              top: "calc(var(--safe-area-top) + 0.75rem)",
              right: "0.75rem",
            }
      }
      mobileOffset={inset}
    />
  );
}
