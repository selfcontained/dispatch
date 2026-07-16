import { Database, Server, Settings } from "lucide-react";

import { AgentTypeSettings } from "@/components/app/agent-type-settings";
import { AppearanceSettings } from "@/components/app/appearance-settings";
import { BrowserExtensionSettings } from "@/components/app/browser-extension-settings";
import { CrossRepoMessagingSettings } from "@/components/app/cross-repo-messaging-settings";
import { IdeSettings } from "@/components/app/ide-settings";
import { InstanceNameSettings } from "@/components/app/instance-name-settings";
import { DocsContent, DOCS_SECTION_NAV } from "@/components/app/docs-pane";
import { NotificationSettings } from "@/components/app/notification-settings";
import { PersonalitySettings } from "@/components/app/personality-settings";
import { ReleasesAdmin } from "@/components/app/release-admin";
import { UpdatesSection } from "@/components/app/release-manager";
import { SecuritySettings } from "@/components/app/security-settings";
import { ServiceStatus } from "@/components/app/service-status";
import { ServiceResourcesSettings } from "@/components/app/service-resources-settings";
import { type ServiceState } from "@/components/app/types";
import { WorktreeLocationSettings } from "@/components/app/worktree-location-settings";
import { type IconColorId } from "@/hooks/use-icon-color";
import { useReleaseStream } from "@/hooks/use-release-stream";
import { type ThemeId } from "@/hooks/use-theme";
import { type AgentType } from "@/lib/agent-types";
import { type IdeType } from "@/lib/ide-types";
import { type SettingsSection } from "@/components/app/settings-state";
import { cn } from "@/lib/utils";

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
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {sections.map(({ id, label, icon: Icon }) => (
          <div key={id}>
            <button
              type="button"
              onClick={() => onSectionChange(id)}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm transition-colors",
                activeSection === id
                  ? "bg-primary/10 text-foreground border border-primary/20"
                  : "border border-transparent text-muted-foreground hover:bg-white/[0.04] hover:text-foreground"
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
        <div className="flex justify-around text-xs text-muted-foreground">
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
  enabledIdes,
  onEnabledIdesChange,
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
  enabledIdes: IdeType[];
  onEnabledIdesChange: (ides: IdeType[]) => void;
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
            <PersonalitySettings />
            <div className="border-t border-border">
              <AgentTypeSettings
                enabledAgentTypes={enabledAgentTypes}
                onChange={onEnabledAgentTypesChange}
              />
            </div>
            <div className="border-t border-border">
              <IdeSettings
                enabledIdes={enabledIdes}
                onChange={onEnabledIdesChange}
              />
            </div>
            <div className="border-t border-border">
              <CrossRepoMessagingSettings />
            </div>
            <div className="px-6 pb-6">
              <WorktreeLocationSettings />
            </div>
          </div>
        )}
        {activeSection === "notifications" && <NotificationSettings />}
        {activeSection === "connections" && <BrowserExtensionSettings />}
        {activeSection === "resources" && <ServiceResourcesSettings />}
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
