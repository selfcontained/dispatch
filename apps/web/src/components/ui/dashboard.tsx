import * as React from "react";

import { cn } from "@/lib/utils";
import { Panel } from "./card";

/** A dashboard's section: a sentence-case title and its range, muted. */
export function DashboardSection({
  title,
  range,
  description,
  children,
  className,
  ...props
}: Omit<React.HTMLAttributes<HTMLElement>, "title"> & {
  title: React.ReactNode;
  range?: React.ReactNode;
  description?: React.ReactNode;
}): JSX.Element {
  const id = React.useId();
  return (
    <section
      aria-labelledby={id}
      className={cn("min-w-0 space-y-3", className)}
      {...props}
    >
      <div>
        <h2 id={id} className="text-heading-sm text-foreground">
          {title}
          {range ? (
            <span className="font-normal text-muted-foreground">
              {" "}
              · {range}
            </span>
          ) : null}
        </h2>
        {description ? (
          <p className="mt-1 break-words text-body-sm text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      {children}
    </section>
  );
}

/** A row of figures: two across on a phone. */
export function StatGrid({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): JSX.Element {
  return (
    <div
      className={cn(
        "grid grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-3",
        className
      )}
      {...props}
    />
  );
}

/** The one frame a chart is drawn in. */
export function ChartFrame({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): JSX.Element {
  return (
    <Panel
      data-chart-frame=""
      className={cn("flex h-56 w-full flex-col sm:h-64", className)}
      {...props}
    />
  );
}

export type LegendItem = {
  key: string;
  label: React.ReactNode;
  /** Any CSS colour; series take theirs from the chart tokens. */
  color?: string;
  icon?: React.ComponentType;
};

/** The one legend. */
export function Legend({
  items,
  className,
}: {
  items: LegendItem[];
  className?: string;
}): JSX.Element {
  return (
    <ul
      data-legend=""
      className={cn(
        "flex shrink-0 flex-wrap items-center justify-center gap-x-4 gap-y-1 text-body-sm text-muted-foreground",
        className
      )}
    >
      {items.map(({ key, label, color, icon: Icon }) => (
        <li
          key={key}
          className="flex items-center gap-1.5 [&>svg]:size-icon-sm"
        >
          {Icon ? (
            <Icon />
          ) : (
            <span
              aria-hidden="true"
              className="size-2 shrink-0 rounded-mark"
              style={{ backgroundColor: color }}
            />
          )}
          {label}
        </li>
      ))}
    </ul>
  );
}

/** A horizontal ratio bar, under its name and value. */
export function Meter({
  label,
  value,
  ratio,
  color,
}: {
  label: string;
  value: React.ReactNode;
  /** 0 to 1. */
  ratio: number;
  color: string;
}): JSX.Element {
  return (
    <div className="min-w-0 space-y-1">
      <div className="flex min-w-0 items-center justify-between gap-2 text-body-sm">
        <span className="min-w-0 truncate text-foreground" title={label}>
          {label}
        </span>
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {value}
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-surface-hover">
        <div
          className="h-full rounded-full transition-[width]"
          style={{
            width: `${Math.min(Math.max(ratio * 100, 1), 100)}%`,
            backgroundColor: color,
          }}
        />
      </div>
    </div>
  );
}
