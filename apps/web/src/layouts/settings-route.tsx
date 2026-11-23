import { useCallback } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  SettingsContent,
  SettingsNavContent,
} from "@/components/app/settings-pane";
import { useSettingsState } from "@/components/app/settings-state";
import { type ServiceState } from "@/components/app/types";
import { SectionShell } from "./section-shell";
import { useDashboardContext } from "@/components/app/dashboard-context";
import { type StatusDotTone } from "@/components/ui/status-dot";

export function serviceDotTone(state: ServiceState): StatusDotTone {
  if (state === "ok") return "success";
  if (state === "down") return "danger";
  return "warning";
}

export function SettingsRoute(): JSX.Element {
  const navigate = useNavigate();
  const { section, subsection } = useParams();
  const context = useDashboardContext();
  const { activeSection, setActiveSectionState, isAdmin, sections } =
    useSettingsState(true, section);

  const handleSettingsSectionChange = useCallback(
    (nextSection: string | null) => {
      if (!nextSection) return;
      setActiveSectionState(
        nextSection as Parameters<typeof setActiveSectionState>[0]
      );
      navigate(`/settings/${nextSection}`, { replace: true });
      if (context.isMobile) context.setMobileLeftOpen(false);
    },
    [context, navigate, setActiveSectionState]
  );

  return (
    <SectionShell
      activeSection="settings"
      sidebar={
        <SettingsNavContent
          activeSection={activeSection}
          activeSubsection={subsection}
          sections={sections}
          onSectionChange={handleSettingsSectionChange}
          onSubsectionChange={(nextSubsection) => {
            navigate(`/settings/help/${nextSubsection}`, { replace: true });
            if (context.isMobile) context.setMobileLeftOpen(false);
          }}
          apiState={context.apiState}
          dbState={context.dbState}
          serviceDotTone={serviceDotTone}
        />
      }
    >
      <SettingsContent
        activeSection={activeSection}
        onLogout={context.handleLogout}
        theme={context.theme}
        setTheme={context.setTheme}
        enabledAgentTypes={context.enabledAgentTypes}
        onEnabledAgentTypesChange={context.setEnabledAgentTypes}
        enabledIdes={context.enabledIdes}
        onEnabledIdesChange={context.setEnabledIdes}
        initialSubsection={subsection}
        onSubsectionChange={(nextSubsection) => {
          if (section !== "help") return;
          navigate(
            nextSubsection
              ? `/settings/help/${nextSubsection}`
              : "/settings/help",
            { replace: true }
          );
        }}
        isAdmin={isAdmin}
      />
    </SectionShell>
  );
}
