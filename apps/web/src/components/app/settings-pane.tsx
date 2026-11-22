import { RoutingSettings } from "./routing-settings";
import { lazy, Suspense } from "react";
import { Database, Server, Settings } from "lucide-react";

import { UserAvatarSettings } from "@/components/app/user-avatar/user-avatar-settings";
import { AgentTypeSettings } from "@/components/app/agent-type-settings";
import { AppearanceSettings } from "@/components/app/appearance-settings";
import { BrowserExtensionSettings } from "@/components/app/browser-extension-settings";
import { IdeSettings } from "@/components/app/ide-settings";
import { InstanceNameSettings } from "@/components/app/instance-name-settings";
import { DocsContent, DOCS_SECTION_NAV } from "@/components/app/docs-pane";
import { EngineSignInSettings } from "@/components/app/engine-sign-in-settings";
import { NotificationSettings } from "@/components/app/notification-settings";
import { PersonalitySettings } from "@/components/app/personality-settings";
import { PluginUpdateSettings } from "@/components/app/plugin-update-settings";
import { ReleasesAdmin } from "@/components/app/release-admin";
import { UpdatesSection } from "@/components/app/updates-section";
import { SecuritySettings } from "@/components/app/security-settings";
import { ServiceStatus } from "@/components/app/service-status";
import { ServiceResourcesSettings } from "@/components/app/service-resources-settings";
import { type ServiceState } from "@/components/app/types";
import { WorktreeLocationSettings } from "@/components/app/worktree-location-settings";
import { useReleaseStream } from "@/hooks/use-release-stream";
import { type ThemeId } from "@/hooks/use-theme";
import { type AgentType } from "@/lib/agent-types";
import { type IdeType } from "@/lib/ide-types";
import { SettingsPage } from "@/components/app/settings-layout";
import { type SettingsSection } from "@/components/app/settings-state";
import { cn } from "@/lib/utils";
import { RowButton } from "@/components/ui/row-button";
import { type StatusDotTone } from "@/components/ui/status-dot";
import { LoadingSkeleton } from "@/components/ui/skeleton";

const UpdatePreview = import.meta.env.DEV
  ? lazy(() => import("./update-preview"))
  : null;

/** Settings nav for the sidebar. */
export function SettingsNavContent({
  activeSection,
  activeSubsection,
  sections,
  onSectionChange,
  onSubsectionChange,
  apiState,
  dbState,
  serviceDotTone,
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
  serviceDotTone: (state: ServiceState) => StatusDotTone;
}): JSX.Element {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mt-2 flex h-14 items-center border-b border-border px-3">
        <div className="section-label">Settings</div>
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {sections.map(({ id, label, icon: Icon }) => (
          <div key={id}>
            <RowButton
              selected={activeSection === id}
              aria-current={activeSection === id ? "page" : undefined}
              onClick={() => onSectionChange(id)}
              className={cn(
                "border px-3 py-3 text-body-md",
                activeSection === id
                  ? "border-primary/tint-strong"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              <Icon className="size-icon-md shrink-0" />
              {label}
            </RowButton>
            {/* Help sub-menu: show docs sections when Help is active */}
            {id === "help" && activeSection === "help" && (
              <div className="ml-4 border-l border-border">
                {DOCS_SECTION_NAV.map((doc) => (
                  <RowButton
                    key={doc.id}
                    onClick={() => onSubsectionChange?.(doc.id)}
                    className={cn(
                      "px-4 py-1.5 text-body-sm",
                      activeSubsection === doc.id
                        ? "text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    {doc.label}
                  </RowButton>
                ))}
              </div>
            )}
          </div>
        ))}
      </nav>
      <div className="border-t border-border px-4 pb-3 pt-4">
        <div className="flex justify-around text-body-sm text-muted-foreground">
          <ServiceStatus
            icon={<Server className="h-3.5 w-3.5" />}
            label="API"
            value={apiState}
            dotTone={serviceDotTone(apiState)}
          />
          <ServiceStatus
            icon={<Database className="h-3.5 w-3.5" />}
            label="DB"
            value={dbState}
            dotTone={serviceDotTone(dbState)}
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
  enabledAgentTypes,
  onEnabledAgentTypesChange,
  enabledIdes,
  onEnabledIdesChange,
  initialSubsection,
  onSubsectionChange,
  isAdmin,
}: {
  activeSection: SettingsSection | null;
  onLogout: () => void | Promise<void>;
  theme: ThemeId;
  setTheme: (id: ThemeId) => void;
  enabledAgentTypes: AgentType[];
  onEnabledAgentTypesChange: (agentTypes: AgentType[]) => void;
  enabledIdes: IdeType[];
  onEnabledIdesChange: (ides: IdeType[]) => void;
  initialSubsection?: string;
  onSubsectionChange?: (subsection: string | null) => void;
  isAdmin: boolean;
}): JSX.Element {
  // Owned here, not inside UpdatesSection: this component stays mounted
  // across settings-section switches, so an in-flight update's restart
  // health-poll (client-side-only state — the server is briefly down and
  // can't hand it back via a fresh snapshot) survives navigating away
  // from the Updates tab and back. ReleasesAdmin has no equivalent
  // requirement (release-creation never restarts the server, and the
  // create job's log/progress lives server-side, so a fresh mount just
  // gets it back via the stream snapshot) and keeps owning its own
  // create-kind stream locally.
  const updateStream = useReleaseStream("update");

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background">
      {/* Keyed by page, so each starts at its top. */}
      <div
        key={
          activeSection === "help"
            ? `help/${initialSubsection ?? ""}`
            : activeSection
        }
        className="flex min-h-0 min-w-0 flex-1 flex-col"
      >
        {activeSection === "general" && (
          <SettingsPage page="general">
            <InstanceNameSettings />
            <UserAvatarSettings />
            <AppearanceSettings theme={theme} setTheme={setTheme} />
          </SettingsPage>
        )}
        {activeSection === "agents" && (
          <SettingsPage page="agents">
            <AgentTypeSettings
              enabledAgentTypes={enabledAgentTypes}
              onChange={onEnabledAgentTypesChange}
            />
            <EngineSignInSettings />
            <RoutingSettings />
            <PersonalitySettings />
          </SettingsPage>
        )}
        {activeSection === "workspace" && (
          <SettingsPage page="workspace">
            <IdeSettings
              enabledIdes={enabledIdes}
              onChange={onEnabledIdesChange}
            />
            <WorktreeLocationSettings />
          </SettingsPage>
        )}
        {activeSection === "security" && (
          <SettingsPage page="security">
            <SecuritySettings onLogout={onLogout} />
          </SettingsPage>
        )}
        {activeSection === "notifications" && (
          <SettingsPage page="notifications">
            <NotificationSettings />
          </SettingsPage>
        )}
        {activeSection === "connections" && (
          <SettingsPage page="connections">
            <BrowserExtensionSettings />
          </SettingsPage>
        )}
        {/* Its header holds the history window, so it draws its own. */}
        {activeSection === "resources" && <ServiceResourcesSettings />}
        {activeSection === "updates" && (
          <SettingsPage page="updates">
            {UpdatePreview &&
            new URLSearchParams(window.location.search).has(
              "simulateUpdate"
            ) ? (
              <Suspense
                fallback={<LoadingSkeleton label="Loading update preview…" />}
              >
                <UpdatePreview />
              </Suspense>
            ) : (
              <UpdatesSection stream={updateStream} />
            )}
            <PluginUpdateSettings />
          </SettingsPage>
        )}
        {activeSection === "help" && (
          <SettingsPage page="help">
            <DocsContent
              initialSection={initialSubsection}
              onSectionChange={onSubsectionChange}
            />
          </SettingsPage>
        )}
        {activeSection === "releases" && isAdmin && (
          <SettingsPage page="releases">
            <ReleasesAdmin />
          </SettingsPage>
        )}
      </div>
    </div>
  );
}
