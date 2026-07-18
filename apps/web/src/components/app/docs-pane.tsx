import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import {
  ArrowDownToLine,
  Bell,
  Briefcase,
  GitBranch,
  Image,
  Keyboard,
  Monitor,
  MousePointerClick,
  PlugZap,
  Signal,
  Sparkles,
  Users,
  X,
} from "lucide-react";

import { ScrollArea } from "@/components/ui/scroll-area";

import {
  AgentsContent,
  AutomationsContent,
  BrowserFeedbackContent,
  EventsContent,
  MediaContent,
  NotificationsContent,
  PersonalitiesContent,
  PersonasContent,
  ShortcutsContent,
  ToolsContent,
  UpdatesContent,
  WorktreesContent,
} from "./docs-sections";

export type DocsSection =
  | "agents"
  | "shortcuts"
  | "personalities"
  | "tools"
  | "automations"
  | "worktrees"
  | "personas"
  | "events"
  | "media"
  | "browser-feedback"
  | "notifications"
  | "updates";

type DocsPaneProps = {
  open: boolean;
  onClose: () => void;
  initialSection?: string;
  onSectionChange?: (section: string | null) => void;
};

type SectionDef = {
  id: DocsSection;
  label: string;
  icon: typeof Monitor;
  title: string;
  content: JSX.Element;
};

const SECTIONS: SectionDef[] = [
  {
    id: "agents",
    label: "Agents",
    icon: Monitor,
    title: "Agents",
    content: <AgentsContent />,
  },
  {
    id: "shortcuts",
    label: "Keyboard Shortcuts",
    icon: Keyboard,
    title: "Keyboard Shortcuts",
    content: <ShortcutsContent />,
  },
  {
    id: "personalities",
    label: "Personalities",
    icon: Sparkles,
    title: "Personalities",
    content: <PersonalitiesContent />,
  },
  {
    id: "tools",
    label: "Repo Tools",
    icon: PlugZap,
    title: "Repo Tools",
    content: <ToolsContent />,
  },
  {
    id: "automations",
    label: "Automations",
    icon: Briefcase,
    title: "Automations: Templates & Jobs",
    content: <AutomationsContent />,
  },
  {
    id: "worktrees",
    label: "Worktrees",
    icon: GitBranch,
    title: "Worktrees",
    content: <WorktreesContent />,
  },
  {
    id: "personas",
    label: "Reviewers",
    icon: Users,
    title: "Reviewers",
    content: <PersonasContent />,
  },
  {
    id: "events",
    label: "Status Events",
    icon: Signal,
    title: "Status Events",
    content: <EventsContent />,
  },
  {
    id: "media",
    label: "Media",
    icon: Image,
    title: "Media & Sharing",
    content: <MediaContent />,
  },
  {
    id: "browser-feedback",
    label: "Browser Feedback",
    icon: MousePointerClick,
    title: "Browser Feedback",
    content: <BrowserFeedbackContent />,
  },
  {
    id: "notifications",
    label: "Notifications",
    icon: Bell,
    title: "Notifications",
    content: <NotificationsContent />,
  },
  {
    id: "updates",
    label: "Updates",
    icon: ArrowDownToLine,
    title: "Updates",
    content: <UpdatesContent />,
  },
];

function isValidDocsSection(value: string | undefined): value is DocsSection {
  return value !== undefined && SECTIONS.some((s) => s.id === value);
}

/** Lightweight section metadata for sidebar nav (avoids importing heavy content JSX). */
export const DOCS_SECTION_NAV = SECTIONS.map(({ id, label }) => ({
  id,
  label,
}));

type DocsContentProps = {
  initialSection?: string;
  onSectionChange?: (section: string | null) => void;
  title?: string;
};

export function DocsContent({
  initialSection,
  onSectionChange: _onSectionChange,
  title = "Docs",
}: DocsContentProps): JSX.Element {
  const location = useLocation();
  const resolvedInitial = isValidDocsSection(initialSection)
    ? initialSection
    : null;
  const [activeSection, setActiveSectionState] = useState<DocsSection | null>(
    resolvedInitial
  );
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isValidDocsSection(initialSection)) {
      setActiveSectionState(initialSection);
    }
  }, [initialSection]);

  useEffect(() => {
    const hash = location.hash.replace("#", "");
    if (!hash || !contentRef.current) return;
    const frame = requestAnimationFrame(() => {
      const el = contentRef.current?.querySelector(`#${CSS.escape(hash)}`);
      el?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    return () => cancelAnimationFrame(frame);
  }, [location.hash, activeSection]);

  const active =
    SECTIONS.find((section) => section.id === activeSection) ?? SECTIONS[0];

  return (
    <div className="flex min-h-0 flex-1 items-stretch">
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <ScrollArea className="h-full">
          <div
            ref={contentRef}
            className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-5 py-6 md:px-8 md:py-8"
          >
            <div className="border-b border-border pb-5">
              <div>
                <div className="text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground">
                  {title}
                </div>
                <h2 className="text-2xl font-semibold tracking-tight">
                  {active.title}
                </h2>
              </div>
            </div>
            <div className="grid gap-6">{active.content}</div>
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}

export function DocsPane({
  open,
  onClose,
  initialSection,
  onSectionChange,
}: DocsPaneProps): JSX.Element {
  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[70] bg-black/50 backdrop-blur-md data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          data-testid="docs-pane"
          className="fixed inset-0 z-[70] flex flex-col overflow-hidden border border-white/[0.2] bg-[hsl(var(--card))] backdrop-blur-2xl text-foreground shadow-[0_16px_64px_rgba(0,0,0,0.5),inset_0_1px_0_rgba(255,255,255,0.15)] duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 md:inset-4 md:rounded-sm"
        >
          <DialogPrimitive.Title className="sr-only">
            Dispatch Docs
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Product documentation for core Dispatch functionality
          </DialogPrimitive.Description>
          <div className="flex h-12 shrink-0 items-center border-b border-border px-5">
            <span className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Docs
            </span>
            <DialogPrimitive.Close className="ml-auto rounded-sm p-1 opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring">
              <X className="h-4 w-4" />
              <span className="sr-only">Close</span>
            </DialogPrimitive.Close>
          </div>
          <DocsContent
            initialSection={initialSection}
            onSectionChange={onSectionChange}
          />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
