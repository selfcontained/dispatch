import * as React from "react";

import { cn } from "@/lib/utils";

/** What the shell puts in every page's header: its first and last controls. */
export type PageChrome = {
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
};

export const PageChromeContext = React.createContext<PageChrome>({});

export interface PageHeaderProps {
  /** The page's h1. */
  title: React.ReactNode;
  /** Follows the title, muted: the project a board is for. */
  context?: React.ReactNode;
  /** One line. It truncates rather than growing the header. */
  description?: React.ReactNode;
  /** A Badge for the thing the page is about. */
  status?: React.ReactNode;
  /** The page's actions and filters. They take a second row on a phone. */
  actions?: React.ReactNode;
  /** Before the title, after the shell's leading control. */
  start?: React.ReactNode;
  /**
   * A workspace's tabs, centred where the title would be. The title is then
   * only read out, and the actions stay on the one row.
   */
  center?: React.ReactNode;
  className?: string;
}

const plainText = (node: React.ReactNode) =>
  typeof node === "string" ? node : undefined;

/** The one page header: 56px, title and context left, actions right. */
export function PageHeader({
  title,
  context,
  description,
  status,
  actions,
  start,
  center,
  className,
}: PageHeaderProps): JSX.Element {
  const { leading, trailing } = React.useContext(PageChromeContext);
  if (center) {
    return (
      <header
        data-testid="page-header"
        className={cn(
          // On phones the side columns hug their buttons so the tab strip
          // gets the rest of the width, and scrolls inside it.
          "relative z-sticky grid h-14 shrink-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center border-b border-border-subtle bg-background px-1 md:grid-cols-[1fr_auto_1fr] md:px-3",
          className
        )}
      >
        <h1 className="sr-only">{title}</h1>
        <div className="flex items-center md:gap-1">
          {leading}
          {start}
        </div>
        <div className="flex min-w-0 items-center justify-center self-stretch">
          {center}
        </div>
        <div className="flex items-center justify-end md:gap-1">
          {actions}
          {trailing}
        </div>
      </header>
    );
  }
  return (
    <header
      data-testid="page-header"
      className={cn(
        "relative z-sticky flex shrink-0 flex-wrap items-center gap-x-2 border-b border-border-subtle bg-background pl-4 pr-2 md:h-14 md:flex-nowrap md:pr-3",
        className
      )}
    >
      {leading || start ? (
        <div className="-ml-2 flex shrink-0 items-center">
          {leading}
          {start}
        </div>
      ) : null}
      {/* Over the border, so one row is 56px. On a phone a long title takes
          a second line rather than losing its end. */}
      <div className="-mb-px flex min-h-14 min-w-0 flex-1 flex-col justify-center py-1 md:mb-0 md:h-full md:min-h-0 md:py-0">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 md:flex-nowrap">
          <h1
            className="line-clamp-2 min-w-0 break-words text-heading-lg md:block md:truncate"
            title={
              [plainText(title), plainText(context)]
                .filter(Boolean)
                .join(" · ") || undefined
            }
          >
            {title}
            {context ? (
              <span className="text-body-md font-normal text-muted-foreground">
                {" · "}
                {context}
              </span>
            ) : null}
          </h1>
          {status}
        </div>
        {description ? (
          <p
            className="line-clamp-2 break-words text-body-sm text-muted-foreground md:block md:truncate"
            title={plainText(description)}
          >
            {description}
          </p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2 max-md:order-last max-md:basis-full max-md:pb-2 md:shrink-0 md:flex-nowrap">
          {actions}
        </div>
      ) : null}
      {trailing ? (
        <div className="flex shrink-0 items-center">{trailing}</div>
      ) : null}
    </header>
  );
}

/**
 * What is under a PageHeader. `contained` scrolls, 960px at most and centred:
 * dashboards, settings, forms. `full` hands the whole area to a board, a
 * chat or a diff, which scrolls itself.
 */
export function PageContent({
  mode = "contained",
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  mode?: "contained" | "full";
}): JSX.Element {
  if (mode === "full") {
    return (
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
          className
        )}
        {...props}
      >
        {children}
      </div>
    );
  }
  return (
    <div
      data-page-content="contained"
      className="min-h-0 w-full min-w-0 flex-1 overflow-y-auto overscroll-contain"
      {...props}
    >
      <div
        className={cn(
          "mx-auto w-full min-w-0 max-w-page px-4 pt-6 pb-safe-6 md:px-6",
          className
        )}
      >
        {children}
      </div>
    </div>
  );
}
