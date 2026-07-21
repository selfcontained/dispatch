import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
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
