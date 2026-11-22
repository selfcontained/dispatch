import { useId } from "react";

import type { SettingsSection as SettingsPageId } from "@/components/app/settings-state";
import { PageContent, PageHeader } from "@/components/ui/page-header";
import {
  SaveFailure,
  SavedNote,
  type SaveStatus,
} from "@/components/ui/setting-row";
import { cn } from "@/lib/utils";

/** Each page's title and its one line, short enough for a phone. */
export const SETTINGS_PAGES: Record<
  SettingsPageId,
  { title: string; description: string }
> = {
  general: { title: "General", description: "Name, avatar and appearance" },
  agents: { title: "Agents", description: "Engines, models and AI features" },
  workspace: { title: "Workspace", description: "Editors and worktrees" },
  security: { title: "Security", description: "Password and trust" },
  connections: {
    title: "Connections",
    description: "Tools that send work to agents",
  },
  notifications: {
    title: "Notifications",
    description: "How Dispatch gets your attention",
  },
  resources: {
    title: "Resources",
    description: "Service and host health",
  },
  updates: {
    title: "Updates",
    description: "Versions, engines and plugins",
  },
  help: { title: "Help", description: "Guides to using Dispatch" },
  releases: {
    title: "Releases",
    description: "Create and promote releases",
  },
};

/** A Settings page: the shared header over contained content. */
export function SettingsPage({
  page,
  status,
  actions,
  className,
  children,
}: {
  page: SettingsPageId;
  status?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}): JSX.Element {
  const { title, description } = SETTINGS_PAGES[page];
  return (
    <>
      <PageHeader
        title={title}
        description={description}
        status={status}
        actions={actions}
      />
      <PageContent className={cn("space-y-8", className)}>
        {children}
      </PageContent>
    </>
  );
}

/** A group on a Settings page: its label, then its rows. */
export function SettingsGroup({
  title,
  description,
  actions,
  status,
  children,
  ...props
}: Omit<React.HTMLAttributes<HTMLElement>, "title"> & {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  /** For a setting that is the whole group: one choice from a list. */
  status?: SaveStatus;
}): JSX.Element {
  const id = useId();
  return (
    <section
      aria-labelledby={props["aria-label"] ? undefined : id}
      {...props}
      className={cn("min-w-0 space-y-3", props.className)}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2">
            <h2 id={id} className="section-label">
              {title}
            </h2>
            {status ? <SavedNote status={status} /> : null}
          </div>
          {description ? (
            <p className="mt-1.5 max-w-reading text-body-sm text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
        {actions}
      </div>
      {status ? <SaveFailure status={status} /> : null}
      <div className="min-w-0 space-y-2">{children}</div>
    </section>
  );
}
