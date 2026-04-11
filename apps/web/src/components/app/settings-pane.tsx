import { useCallback, useEffect, useRef, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { ArrowDownToLine, ArrowLeft, Bell, ChevronRight, Database, Package, Server, Settings, Users, X } from "lucide-react";

import { AgentTypeSettings } from "@/components/app/agent-type-settings";
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

type SettingsSection = "general" | "agents" | "notifications" | "updates" | "releases";

const BASE_SECTIONS: Array<{ id: SettingsSection; label: string; icon: typeof ArrowDownToLine }> = [
  { id: "general", label: "General", icon: Settings },
  { id: "agents", label: "Agents", icon: Users },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "updates", label: "Updates", icon: ArrowDownToLine },
];

const RELEASES_SECTION = { id: "releases" as SettingsSection, label: "Releases", icon: Package };

function InstanceNameSettings(): JSX.Element {
  const { instanceName, setInstanceName, isSaving, saveError, didSave, clearSaveState } = useInstanceName();
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
      <label htmlFor="instance-name" className="mb-1.5 block text-[10px] uppercase tracking-widest text-muted-foreground">
        Instance name
      </label>
      <p className="mb-3 text-sm text-muted-foreground">
        Give this Dispatch instance a name to distinguish it from others. Shown in the sidebar and browser tab.
      </p>
      <div className="flex items-center gap-2">
        <input
          id="instance-name"
          ref={inputRef}
          type="text"
          value={draft}
          onChange={(e) => { setDraft(e.target.value); if (saveError) clearSaveState(); }}
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
            saveError ? "border-destructive" : "border-border focus:border-primary/50"
          )}
        />
        {showSaved && !saveError ? (
          <span className="text-xs text-muted-foreground">Saved</span>
        ) : null}
      </div>
      {saveError ? (
        <p className="mt-1.5 text-xs text-destructive">Failed to save. Please try again.</p>
      ) : null}
    </div>
  );
}

// AppSettings (About) has been merged into UpdatesSection in release-manager.tsx

type WorktreeLocation = "sibling" | "nested";

function WorktreeLocationSettings(): JSX.Element {
  const [worktreeLocation, setWorktreeLocation] = useState<WorktreeLocation>("sibling");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api<{ worktreeLocation: WorktreeLocation }>("/api/v1/agents/settings")
      .then((data) => {
        if (!cancelled) setWorktreeLocation(data.worktreeLocation);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const handleChange = useCallback(async (value: WorktreeLocation) => {
    setWorktreeLocation(value);
    setSaving(true);
    try {
      await api<{ worktreeLocation: WorktreeLocation }>("/api/v1/agents/settings", {
        method: "POST",
        body: JSON.stringify({ worktreeLocation: value }),
      });
    } catch {
      // revert on error
    } finally {
      setSaving(false);
    }
  }, []);

  const options: Array<{ value: WorktreeLocation; label: string; description: string }> = [
    {
      value: "sibling",
      label: "Sibling directories",
      description: "Worktrees are created next to the repo (e.g. ../repo-branch-name)"
    },
    {
      value: "nested",
      label: "Inside .dispatch/worktrees",
      description: "Worktrees are created inside the repo in .dispatch/worktrees/"
    }
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
              <div className="text-sm font-medium text-foreground">{opt.label}</div>
              <div className="text-xs text-muted-foreground">{opt.description}</div>
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
                <div className="text-sm font-medium text-foreground">{t.label}</div>
                <div className="text-xs text-muted-foreground">{t.description}</div>
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
          Pick a color for the app icon to help distinguish multiple Dispatch installations.
        </p>
        <div className={cn("flex flex-wrap gap-2", isIconColorSaving && "pointer-events-none opacity-60")} role="radiogroup" aria-label="Icon color">
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
              <span className={cn(
                "text-[10px] leading-none",
                displayColor === c.id ? "text-foreground" : "text-muted-foreground"
              )}>{c.label}</span>
            </button>
          ))}
        </div>
        {iconColorError ? (
          <p className="mt-2 text-xs text-destructive">
            {iconColorError}{" "}
            <button onClick={clearIconColorError} className="underline hover:no-underline">Dismiss</button>
          </p>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground/70">
            Changing the icon color will reload the page. PWA users may need to reinstall for launcher icons to update.
          </p>
        )}
      </div>
    </div>
  );
}

const ALL_VALID_SECTIONS: SettingsSection[] = ["general", "agents", "notifications", "updates", "releases"];

function isValidSection(value: string | undefined): value is SettingsSection {
  return value !== undefined && ALL_VALID_SECTIONS.includes(value as SettingsSection);
}

type SettingsPaneProps = {
  open: boolean;
  onClose: () => void;
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
  onSectionChange?: (section: string | null) => void;
};

export function SettingsPane({
  open,
  onClose,
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
  apiState,
  dbState,
  serviceDotClass,
  initialSection,
  onSectionChange,
}: SettingsPaneProps): JSX.Element {
  const resolvedInitial = isValidSection(initialSection) ? initialSection : "general";
  const [activeSection, setActiveSectionState] = useState<SettingsSection | null>(resolvedInitial);
  const [isAdmin, setIsAdmin] = useState(false);

  const releaseStream = useReleaseStream();

  // Check admin status on mount
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void api<{ isAdmin: boolean }>("/api/v1/release/admin-check")
      .then((data) => { if (!cancelled) setIsAdmin(data.isAdmin); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [open]);

  const sections = isAdmin ? [...BASE_SECTIONS, RELEASES_SECTION] : BASE_SECTIONS;

  // Sync from URL when initialSection changes (e.g. navigating directly to /settings/appearance)
  useEffect(() => {
    if (open && isValidSection(initialSection)) {
      // Don't navigate to releases if not admin
      if (initialSection === "releases" && !isAdmin) {
        setActiveSectionState("general");
      } else {
        setActiveSectionState(initialSection);
      }
    }
  }, [open, initialSection, isAdmin]);

  const setActiveSection = useCallback((section: SettingsSection | null) => {
    setActiveSectionState(section);
    onSectionChange?.(section);
  }, [onSectionChange]);

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          onClose();
          setActiveSectionState("general");
        }
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[70] bg-black/70 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content className="fixed inset-0 md:inset-4 z-[70] flex flex-col overflow-hidden rounded-none md:rounded-sm border border-border bg-card text-foreground shadow-2xl duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95">
          <DialogPrimitive.Title className="sr-only">Settings</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">Dispatch settings and release manager</DialogPrimitive.Description>

          {/* Header */}
          <div className="flex h-12 shrink-0 items-center border-b border-border px-5">
            {/* Mobile back button when viewing a section */}
            {activeSection !== null && (
              <button
                onClick={() => setActiveSection(null)}
                className="mr-2 rounded-sm p-1 opacity-70 transition-opacity hover:opacity-100 md:hidden"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
            )}
            <span className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              {activeSection !== null ? (
                <span className="md:hidden">{sections.find((s) => s.id === activeSection)?.label ?? "Settings"}</span>
              ) : null}
              <span className={activeSection !== null ? "hidden md:inline" : ""}>Settings</span>
            </span>
            <DialogPrimitive.Close className="ml-auto rounded-sm p-1 opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring">
              <X className="h-4 w-4" />
              <span className="sr-only">Close</span>
            </DialogPrimitive.Close>
          </div>

          {/* Body */}
          <div className="flex min-h-0 flex-1">
            {/* Desktop nav — always visible */}
            <nav className="hidden w-48 shrink-0 flex-col border-r border-border py-2 md:flex">
              <div>
                {sections.map(({ id, label, icon: Icon }) => (
                  <div
                    key={id}
                    onClick={() => setActiveSection(id)}
                    className={cn(
                      "flex cursor-pointer items-center gap-2.5 px-4 py-2.5 text-sm transition-colors",
                      activeSection === id
                        ? "bg-muted text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    <Icon className="h-3.5 w-3.5 shrink-0" />
                    {label}
                  </div>
                ))}
              </div>
              <div className="mt-auto border-t border-border px-4 pb-3 pt-4">
                <div className="mb-3 text-[10px] font-semibold uppercase tracking-[0.24em] text-muted-foreground">
                  System
                </div>
                <div className="space-y-2 text-xs text-muted-foreground">
                  <ServiceStatus icon={<Server className="h-3.5 w-3.5" />} label="API" value={apiState} dotClass={serviceDotClass(apiState)} />
                  <ServiceStatus icon={<Database className="h-3.5 w-3.5" />} label="DB" value={dbState} dotClass={serviceDotClass(dbState)} />
                </div>
              </div>
            </nav>

            {/* Mobile nav — section list, shown when no section selected */}
            {activeSection === null && (
              <nav className="flex flex-1 flex-col md:hidden">
                {sections.map(({ id, label, icon: Icon }) => (
                  <button
                    key={id}
                    onClick={() => setActiveSection(id)}
                    className="flex items-center gap-3 border-b border-border px-5 py-3.5 text-sm text-foreground transition-colors active:bg-muted"
                  >
                    <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                    {label}
                    <ChevronRight className="ml-auto h-4 w-4 text-muted-foreground" />
                  </button>
                ))}
                <div className="mt-auto border-t border-border px-5 py-4">
                  <div className="mb-3 text-[10px] font-semibold uppercase tracking-[0.24em] text-muted-foreground">
                    System
                  </div>
                  <div className="space-y-3 text-xs text-muted-foreground">
                    <ServiceStatus icon={<Server className="h-3.5 w-3.5" />} label="API" value={apiState} dotClass={serviceDotClass(apiState)} />
                    <ServiceStatus icon={<Database className="h-3.5 w-3.5" />} label="DB" value={dbState} dotClass={serviceDotClass(dbState)} />
                  </div>
                </div>
              </nav>
            )}

            {/* Content */}
            <div key={activeSection} className={cn("min-h-0 min-w-0 flex-1 overflow-y-auto", activeSection === null && "hidden md:block")}>
              {activeSection === "general" && (
                <div className="flex flex-col">
                  <div className="p-4 md:p-6">
                    <InstanceNameSettings />
                  </div>
                  <div className="border-t border-border">
                    <AppearanceSettings theme={theme} setTheme={setTheme} iconColor={iconColor} setIconColor={setIconColor} isIconColorSaving={isIconColorSaving} iconColorError={iconColorError} clearIconColorError={clearIconColorError} />
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
              {activeSection === "updates" && <UpdatesSection stream={releaseStream} />}
              {activeSection === "releases" && isAdmin && <ReleasesAdmin stream={releaseStream} />}
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
