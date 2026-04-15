import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  Bell,
  BookOpenText,
  Database,
  Package,
  Server,
  Settings,
  Users,
} from "lucide-react";

import { AgentTypeSettings } from "@/components/app/agent-type-settings";
import { DocsContent, DOCS_SECTION_NAV } from "@/components/app/docs-pane";
import { NotificationSettings } from "@/components/app/notification-settings";
import { ReleasesAdmin } from "@/components/app/release-admin";
import { UpdatesSection } from "@/components/app/release-manager";
import { SecuritySettings } from "@/components/app/security-settings";
import { ServiceStatus } from "@/components/app/service-status";
import { type ServiceState } from "@/components/app/types";
import { type IconColorId, ICON_COLOR_OPTIONS } from "@/hooks/use-icon-color";
import { useInstanceName } from "@/hooks/use-instance-name";
import { useReleaseStream } from "@/hooks/use-release-stream";
import { type ThemeId, THEMES } from "@/hooks/use-theme";
import { type AgentType } from "@/lib/agent-types";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

type SettingsSection =
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

function InstanceNameSettings(): JSX.Element {
  const {
    instanceName,
    setInstanceName,
    isSaving,
    saveError,
    didSave,
    clearSaveState,
  } = useInstanceName();
  const [draft, setDraft] = useState(instanceName);
  const inputRef = useRef<HTMLInputElement>(null);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showSaved, setShowSaved] = useState(false);

  // Sync draft when the stored value loads/changes (but not while the user is editing)
  useEffect(() => {
    if (document.activeElement !== inputRef.current) {
      setDraft(instanceName);
    }
  }, [instanceName]);

  // Revert draft on save error
  useEffect(() => {
    if (saveError) {
      setDraft(instanceName);
    }
  }, [saveError, instanceName]);

  // Show brief "Saved" confirmation
  useEffect(() => {
    if (didSave) {
      setShowSaved(true);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => {
        setShowSaved(false);
        clearSaveState();
      }, 2000);
    }
    return () => {
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    };
  }, [didSave, clearSaveState]);

  const save = useCallback(() => {
    const trimmed = draft.trim();
    if (trimmed !== instanceName) {
      setInstanceName(trimmed);
    }
    setDraft(trimmed);
  }, [draft, instanceName, setInstanceName]);

  return (
    <div>
      <label
        htmlFor="instance-name"
        className="mb-1.5 block text-[10px] uppercase tracking-widest text-muted-foreground"
      >
        Instance name
      </label>
      <p className="mb-3 text-sm text-muted-foreground">
        Give this Dispatch instance a name to distinguish it from others. Shown
        in the sidebar and browser tab.
      </p>
      <div className="flex items-center gap-2">
        <input
          id="instance-name"
          ref={inputRef}
          type="text"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            if (saveError) clearSaveState();
          }}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              save();
              inputRef.current?.blur();
            }
          }}
          disabled={isSaving}
          placeholder="e.g. Production, Staging, Local"
          maxLength={100}
          className={cn(
            "w-full max-w-sm rounded border bg-background px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none disabled:opacity-50",
            saveError
              ? "border-destructive"
              : "border-border focus:border-primary/50"
          )}
        />
        {showSaved && !saveError ? (
          <span className="text-xs text-muted-foreground">Saved</span>
        ) : null}
      </div>
      {saveError ? (
        <p className="mt-1.5 text-xs text-destructive">
          Failed to save. Please try again.
        </p>
      ) : null}
    </div>
  );
}

// AppSettings (About) has been merged into UpdatesSection in release-manager.tsx

type WorktreeLocation = "sibling" | "nested";

function WorktreeLocationSettings(): JSX.Element {
  const [worktreeLocation, setWorktreeLocation] =
    useState<WorktreeLocation>("sibling");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api<{ worktreeLocation: WorktreeLocation }>("/api/v1/agents/settings")
      .then((data) => {
        if (!cancelled) setWorktreeLocation(data.worktreeLocation);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const handleChange = useCallback(async (value: WorktreeLocation) => {
    setWorktreeLocation(value);
    setSaving(true);
    try {
      await api<{ worktreeLocation: WorktreeLocation }>(
        "/api/v1/agents/settings",
        {
          method: "POST",
          body: JSON.stringify({ worktreeLocation: value }),
        }
      );
    } catch {
      // revert on error
    } finally {
      setSaving(false);
    }
  }, []);

  const options: Array<{
    value: WorktreeLocation;
    label: string;
    description: string;
  }> = [
    {
      value: "sibling",
      label: "Sibling directories",
      description:
        "Worktrees are created next to the repo (e.g. ../repo-branch-name)",
    },
    {
      value: "nested",
      label: "Inside .dispatch/worktrees",
      description:
        "Worktrees are created inside the repo in .dispatch/worktrees/",
    },
  ];

  return (
    <div>
      <div className="mb-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">
        Worktree location
      </div>
      <p className="mb-3 text-sm text-muted-foreground">
        Choose where git worktrees are created for new agents.
      </p>
      <div className="grid gap-3">
        {options.map((opt) => (
          <button
            key={opt.value}
            onClick={() => void handleChange(opt.value)}
            disabled={saving}
            className={cn(
              "flex items-start gap-3 rounded-md border p-3 text-left transition-colors",
              worktreeLocation === opt.value
                ? "border-primary bg-primary/10"
                : "border-border hover:border-muted-foreground/30"
            )}
          >
            <div className="min-w-0">
              <div className="text-sm font-medium text-foreground">
                {opt.label}
              </div>
              <div className="text-xs text-muted-foreground">
                {opt.description}
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function AppearanceSettings({
  theme,
  setTheme,
  iconColor,
  setIconColor,
  isIconColorSaving,
  iconColorError,
  clearIconColorError,
}: {
  theme: ThemeId;
  setTheme: (id: ThemeId) => void;
  iconColor: IconColorId;
  setIconColor: (id: IconColorId) => void;
  isIconColorSaving: boolean;
  iconColorError: string | null;
  clearIconColorError: () => void;
}): JSX.Element {
  const [pendingColor, setPendingColor] = useState<IconColorId | null>(null);
  const displayColor = pendingColor ?? iconColor;

  // Reset optimistic state on error so the selection reverts
  useEffect(() => {
    if (iconColorError) {
      setPendingColor(null);
    }
  }, [iconColorError]);

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <div>
        <div className="mb-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">
          Theme
        </div>
        <p className="mb-3 text-sm text-muted-foreground">
          Choose a color theme for the interface.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {THEMES.map((t) => (
            <button
              key={t.id}
              onClick={() => setTheme(t.id)}
              className={cn(
                "flex items-start gap-3 rounded-md border p-3 text-left transition-colors",
                theme === t.id
                  ? "border-primary bg-primary/10"
                  : "border-border hover:border-muted-foreground/30"
              )}
            >
              <div className="mt-0.5 flex gap-1">
                {t.swatches.map((color, i) => (
                  <span
                    key={i}
                    className="block h-4 w-4 rounded-full border border-white/10"
                    style={{ backgroundColor: color }}
                  />
                ))}
              </div>
              <div className="min-w-0">
                <div className="text-sm font-medium text-foreground">
                  {t.label}
                </div>
                <div className="text-xs text-muted-foreground">
                  {t.description}
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="mb-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">
          Icon Color
        </div>
        <p className="mb-3 text-sm text-muted-foreground">
          Pick a color for the app icon to help distinguish multiple Dispatch
          installations.
        </p>
        <div
          className={cn(
            "flex flex-wrap gap-2",
            isIconColorSaving && "pointer-events-none opacity-60"
          )}
          role="radiogroup"
          aria-label="Icon color"
        >
          {ICON_COLOR_OPTIONS.map((c) => (
            <button
              key={c.id}
              role="radio"
              aria-checked={displayColor === c.id}
              aria-label={c.label}
              disabled={isIconColorSaving}
              onClick={() => {
                if (c.id !== iconColor) {
                  setPendingColor(c.id);
                  setIconColor(c.id);
                }
              }}
              className={cn(
                "flex w-14 flex-col items-center gap-1 rounded-lg border-2 px-1 py-1.5 transition-all",
                displayColor === c.id
                  ? "border-foreground bg-foreground/10"
                  : "border-transparent hover:border-muted-foreground/40 hover:bg-muted/30"
              )}
            >
              <img
                src={`/icons/${c.id}/brand-icon.svg`}
                alt=""
                className="h-7 w-7 object-contain"
              />
              <span
                className={cn(
                  "text-[10px] leading-none",
                  displayColor === c.id
                    ? "text-foreground"
                    : "text-muted-foreground"
                )}
              >
                {c.label}
              </span>
            </button>
          ))}
        </div>
        {iconColorError ? (
          <p className="mt-2 text-xs text-destructive">
            {iconColorError}{" "}
            <button
              onClick={clearIconColorError}
              className="underline hover:no-underline"
            >
              Dismiss
            </button>
          </p>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground/70">
            Changing the icon color will reload the page. PWA users may need to
            reinstall for launcher icons to update.
          </p>
        )}
      </div>
    </div>
  );
}

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

export type SettingsPaneProps = {
  open: boolean;
  onLogout: () => void;
  theme: ThemeId;
  setTheme: (id: ThemeId) => void;
  iconColor: IconColorId;
  setIconColor: (id: IconColorId) => void;
  isIconColorSaving: boolean;
  iconColorError: string | null;
  clearIconColorError: () => void;
  enabledAgentTypes: AgentType[];
  onEnabledAgentTypesChange: (agentTypes: AgentType[]) => void;
  apiState: ServiceState;
  dbState: ServiceState;
  serviceDotClass: (state: ServiceState) => string;
  initialSection?: string;
  initialSubsection?: string;
  onSectionChange?: (section: string | null) => void;
  onSubsectionChange?: (subsection: string | null) => void;
};

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

/** Settings nav for the sidebar. */
export function SettingsNavContent({
  activeSection,
  activeSubsection,
  sections,
  onSectionChange,
  onSubsectionChange,
  apiState,
  dbState,
  serviceDotClass,
}: {
  activeSection: SettingsSection | null;
  activeSubsection?: string;
  sections: Array<{
    id: SettingsSection;
    label: string;
    icon: typeof Settings;
  }>;
  onSectionChange: (section: SettingsSection) => void;
  onSubsectionChange?: (subsection: string) => void;
  apiState: ServiceState;
  dbState: ServiceState;
  serviceDotClass: (state: ServiceState) => string;
}): JSX.Element {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mt-2 flex h-14 items-center border-b border-border px-3">
        <div className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Settings
        </div>
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto py-2">
        {sections.map(({ id, label, icon: Icon }) => (
          <div key={id}>
            <button
              type="button"
              onClick={() => onSectionChange(id)}
              className={cn(
                "flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm transition-colors",
                activeSection === id
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              <Icon className="h-3.5 w-3.5 shrink-0" />
              {label}
            </button>
            {/* Help sub-menu: show docs sections when Help is active */}
            {id === "help" && activeSection === "help" && (
              <div className="ml-4 border-l border-border">
                {DOCS_SECTION_NAV.map((doc) => (
                  <button
                    key={doc.id}
                    type="button"
                    onClick={() => onSubsectionChange?.(doc.id)}
                    className={cn(
                      "flex w-full items-center px-4 py-1.5 text-left text-xs transition-colors",
                      activeSubsection === doc.id
                        ? "text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    {doc.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </nav>
      <div className="border-t border-border px-4 pb-3 pt-4">
        <div className="mb-3 text-[10px] font-semibold uppercase tracking-[0.24em] text-muted-foreground">
          System
        </div>
        <div className="space-y-2 text-xs text-muted-foreground">
          <ServiceStatus
            icon={<Server className="h-3.5 w-3.5" />}
            label="API"
            value={apiState}
            dotClass={serviceDotClass(apiState)}
          />
          <ServiceStatus
            icon={<Database className="h-3.5 w-3.5" />}
            label="DB"
            value={dbState}
            dotClass={serviceDotClass(dbState)}
          />
        </div>
      </div>
    </div>
  );
}

/** Settings content for the main content area. */
export function SettingsContent({
  activeSection,
  onLogout,
  theme,
  setTheme,
  iconColor,
  setIconColor,
  isIconColorSaving,
  iconColorError,
  clearIconColorError,
  enabledAgentTypes,
  onEnabledAgentTypesChange,
  initialSubsection,
  onSubsectionChange,
  isAdmin,
}: {
  activeSection: SettingsSection | null;
  onLogout: () => void;
  theme: ThemeId;
  setTheme: (id: ThemeId) => void;
  iconColor: IconColorId;
  setIconColor: (id: IconColorId) => void;
  isIconColorSaving: boolean;
  iconColorError: string | null;
  clearIconColorError: () => void;
  enabledAgentTypes: AgentType[];
  onEnabledAgentTypesChange: (agentTypes: AgentType[]) => void;
  initialSubsection?: string;
  onSubsectionChange?: (subsection: string | null) => void;
  isAdmin: boolean;
}): JSX.Element {
  const releaseStream = useReleaseStream();

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <div
        key={activeSection}
        className={cn(
          "min-h-0 min-w-0 flex-1 overflow-y-auto",
          activeSection === "help" && "flex overflow-hidden"
        )}
      >
        {activeSection === "general" && (
          <div className="flex flex-col">
            <div className="p-4 md:p-6">
              <InstanceNameSettings />
            </div>
            <div className="border-t border-border">
              <AppearanceSettings
                theme={theme}
                setTheme={setTheme}
                iconColor={iconColor}
                setIconColor={setIconColor}
                isIconColorSaving={isIconColorSaving}
                iconColorError={iconColorError}
                clearIconColorError={clearIconColorError}
              />
            </div>
            <div className="border-t border-border">
              <SecuritySettings onLogout={onLogout} />
            </div>
          </div>
        )}
        {activeSection === "agents" && (
          <div className="flex flex-col">
            <AgentTypeSettings
              enabledAgentTypes={enabledAgentTypes}
              onChange={onEnabledAgentTypesChange}
            />
            <div className="px-6 pb-6">
              <WorktreeLocationSettings />
            </div>
          </div>
        )}
        {activeSection === "notifications" && <NotificationSettings />}
        {activeSection === "updates" && (
          <UpdatesSection stream={releaseStream} />
        )}
        {activeSection === "help" && (
          <DocsContent
            title="Help & Docs"
            initialSection={initialSubsection}
            onSectionChange={onSubsectionChange}
          />
        )}
        {activeSection === "releases" && isAdmin && (
          <ReleasesAdmin stream={releaseStream} />
        )}
      </div>
    </div>
  );
}
