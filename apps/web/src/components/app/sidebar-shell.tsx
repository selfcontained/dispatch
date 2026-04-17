import {
  Activity,
  AlarmClock,
  Bot,
  ChevronLeft,
  Settings,
  X,
} from "lucide-react";
import React from "react";
import { NavLink } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { useIconColor } from "@/hooks/use-icon-color";
import { useInstanceName } from "@/hooks/use-instance-name";
import { cn } from "@/lib/utils";

export type NavSection = "agents" | "jobs" | "activity" | "settings";

type SidebarNavBarProps = {
  activeSection: NavSection;
};

export function SidebarNavBar({
  activeSection,
}: SidebarNavBarProps): JSX.Element {
  const navButtonClassName = (navItem: string, active = false): string =>
    cn(
      "rounded-md p-2 transition-colors hover:bg-muted/50 hover:text-foreground",
      active ? "text-primary hover:text-primary/80" : "text-muted-foreground"
    );

  const items: Array<{
    id: NavSection;
    icon: typeof Bot;
    label: string;
    to: string;
  }> = [
    { id: "agents", icon: Bot, label: "Agents", to: "/" },
    { id: "jobs", icon: AlarmClock, label: "Jobs", to: "/jobs" },
    { id: "activity", icon: Activity, label: "Activity", to: "/activity" },
    { id: "settings", icon: Settings, label: "Settings", to: "/settings" },
  ];

  return (
    <div className="flex items-center justify-around border-t border-white/[0.12] py-3 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
      {items.map(({ id, icon: Icon, label, to }) => (
        <NavLink
          key={id}
          to={to}
          aria-label={label}
          data-testid={`${id}-button`}
          className={navButtonClassName(id, activeSection === id)}
        >
          <span className="flex items-center justify-center">
            <Icon className="h-5 w-5" />
          </span>
        </NavLink>
      ))}
    </div>
  );
}

type SidebarShellProps = {
  activeSection: NavSection;
  onRequestClose?: () => void;
  closeButtonIcon?: "chevron" | "x";
  children: React.ReactNode;
};

export function SidebarShell({
  activeSection,
  onRequestClose,
  closeButtonIcon = "x",
  children,
}: SidebarShellProps): JSX.Element {
  const { iconColor } = useIconColor();
  const { instanceName } = useInstanceName();

  return (
    <aside
      data-testid="sidebar-shell"
      className="flex h-full min-h-0 w-full flex-col text-foreground"
    >
      <div className="flex min-h-14 items-center px-3 pt-[env(safe-area-inset-top)]">
        <div className="flex items-center gap-2.5">
          <img
            src={`/icons/${iconColor}/brand-icon.svg`}
            alt=""
            className="h-7 w-7 shrink-0 object-contain"
          />
          <div className="flex min-w-0 flex-col justify-center">
            <div className="text-sm font-bold uppercase tracking-widest text-foreground">
              Dispatch
            </div>
            {instanceName ? (
              <div
                title={instanceName}
                className="truncate text-[11px] leading-tight text-muted-foreground"
              >
                {instanceName}
              </div>
            ) : null}
          </div>
        </div>
        {onRequestClose ? (
          <div className="ml-auto">
            <Button
              size="icon"
              variant="ghost"
              onClick={onRequestClose}
              title="Close sidebar"
            >
              {closeButtonIcon === "chevron" ? (
                <ChevronLeft className="h-4 w-4" />
              ) : (
                <X className="h-4 w-4" />
              )}
            </Button>
          </div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>

      <SidebarNavBar activeSection={activeSection} />
    </aside>
  );
}
