import { useEffect, useState } from "react";
import {
  ArrowDownToLine,
  Bell,
  BookOpenText,
  Package,
  Settings,
  Users,
} from "lucide-react";

import { api } from "@/lib/api";

export type SettingsSection =
  | "general"
  | "agents"
  | "notifications"
  | "updates"
  | "help"
  | "releases";

const BASE_SECTIONS: Array<{
  id: SettingsSection;
  label: string;
  icon: typeof ArrowDownToLine;
}> = [
  { id: "general", label: "General", icon: Settings },
  { id: "agents", label: "Agents", icon: Users },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "updates", label: "Updates", icon: ArrowDownToLine },
];

const RELEASES_SECTION = {
  id: "releases" as SettingsSection,
  label: "Releases",
  icon: Package,
};
const HELP_SECTION = {
  id: "help" as SettingsSection,
  label: "Help",
  icon: BookOpenText,
};

const ALL_VALID_SECTIONS: SettingsSection[] = [
  "general",
  "agents",
  "notifications",
  "updates",
  "help",
  "releases",
];

function isValidSection(value: string | undefined): value is SettingsSection {
  return (
    value !== undefined && ALL_VALID_SECTIONS.includes(value as SettingsSection)
  );
}

export function useSettingsState(open: boolean, initialSection?: string) {
  const resolvedInitial = isValidSection(initialSection)
    ? initialSection
    : "general";
  const [activeSection, setActiveSectionState] =
    useState<SettingsSection | null>(resolvedInitial);
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void api<{ isAdmin: boolean }>("/api/v1/release/admin-check")
      .then((data) => {
        if (!cancelled) setIsAdmin(data.isAdmin);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open]);

  const sections = isAdmin
    ? [...BASE_SECTIONS, RELEASES_SECTION, HELP_SECTION]
    : [...BASE_SECTIONS, HELP_SECTION];

  useEffect(() => {
    if (open && isValidSection(initialSection)) {
      if (initialSection === "releases" && !isAdmin) {
        setActiveSectionState("general");
      } else {
        setActiveSectionState(initialSection);
      }
    }
  }, [open, initialSection, isAdmin]);

  return { activeSection, setActiveSectionState, isAdmin, sections };
}
