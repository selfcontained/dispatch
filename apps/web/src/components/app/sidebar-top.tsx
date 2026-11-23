import type { ReactNode } from "react";

import { ProjectSwitcher } from "@/components/app/project-switcher";

/**
 * The top of a section's sidebar, in one order everywhere: scope, then the
 * one primary "New <thing>" across the column. A section switch goes above
 * it, the list below.
 */
export function SidebarTop({
  scope = <ProjectSwitcher />,
  action,
}: {
  scope?: ReactNode;
  action?: ReactNode;
}): JSX.Element {
  return (
    <div
      data-testid="sidebar-top"
      className="flex shrink-0 flex-col gap-2 border-b border-border px-3 py-3"
    >
      {scope}
      {action}
    </div>
  );
}
