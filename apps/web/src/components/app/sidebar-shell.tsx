import {
  Activity,
  AlarmClock,
  Bot,
  ChevronLeft,
  Settings,
  X,
} from "lucide-react";
import React from "react";

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useIconColor } from "@/hooks/use-icon-color";
import { useInstanceName } from "@/hooks/use-instance-name";
import { cn } from "@/lib/utils";

export type NavSection = "agents" | "jobs" | "activity" | "settings";

type SidebarNavBarProps = {
  activeSection?: NavSection;
  onNavigate: (section: NavSection) => void;
  pulsingNavItem?: string | null;
  triggerNavAnimation?: (navItem: string) => void;
};

export function SidebarNavBar({
  activeSection,
  onNavigate,
  pulsingNavItem,
  triggerNavAnimation,
}: SidebarNavBarProps): JSX.Element {
  const navButtonClassName = (navItem: string, active = false): string =>
    cn(
      "rounded-md p-2 transition-colors hover:bg-muted/50 hover:text-foreground",
      active ? "text-primary hover:text-primary/80" : "text-muted-foreground"
    );

  const triggerNavAnimationForKey = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    navItem: string
  ): void => {
    if (event.key === "Enter" || event.key === " ") {
      triggerNavAnimation?.(navItem);
    }
  };

  const items: Array<{ id: NavSection; icon: typeof Bot; label: string }> = [
    { id: "agents", icon: Bot, label: "Agents" },
    { id: "jobs", icon: AlarmClock, label: "Jobs" },
    { id: "activity", icon: Activity, label: "Activity" },
    { id: "settings", icon: Settings, label: "Settings" },
  ];

  return (
    <TooltipProvider delayDuration={120}>
      <div className="flex items-center justify-around border-t border-white/[0.12] py-3 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
        {items.map(({ id, icon: Icon, label }) => (
          <Tooltip key={id}>
            <TooltipTrigger asChild>
              <button
                onPointerDown={() => triggerNavAnimation?.(id)}
                onKeyDown={(event) => triggerNavAnimationForKey(event, id)}
                onClick={() => onNavigate(id)}
                aria-label={label}
                data-testid={`${id}-button`}
                className={cn(
                  navButtonClassName(id, activeSection === id),
                  pulsingNavItem === id && "animate-sidebar-nav-pulse"
                )}
              >
                <span className="flex items-center justify-center">
                  <Icon className="h-5 w-5" />
                </span>
              </button>
            </TooltipTrigger>
            <TooltipContent>{label}</TooltipContent>
          </Tooltip>
        ))}
      </div>
    </TooltipProvider>
  );
}

type SidebarShellProps = {
  activeSection?: NavSection;
  onNavigate: (section: NavSection) => void;
  onRequestClose?: () => void;
  closeButtonIcon?: "chevron" | "x";
  pulsingNavItem?: string | null;
  triggerNavAnimation?: (navItem: string) => void;
  headerActions?: React.ReactNode;
  children: React.ReactNode;
};

export function SidebarShell({
  activeSection,
  onNavigate,
  onRequestClose,
  closeButtonIcon = "x",
  pulsingNavItem,
  triggerNavAnimation,
  headerActions,
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
        {headerActions ? (
          <div className="ml-2 flex items-center gap-1">{headerActions}</div>
        ) : null}
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

      <SidebarNavBar
        activeSection={activeSection}
        onNavigate={onNavigate}
        pulsingNavItem={pulsingNavItem}
        triggerNavAnimation={triggerNavAnimation}
      />
    </aside>
  );
}
