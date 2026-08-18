import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Keyboard, Play, Plus } from "lucide-react";

import {
  type CommandAction,
  type CommandGroup,
} from "@/components/app/command-palette";
import { type Agent } from "@/components/app/types";
import { agentRoute } from "@/lib/agent-routes";
import { partitionAgentsByLineage } from "@/lib/agent-types";
import { useHotkey } from "@/lib/hotkeys/use-hotkey";
import { useTemplates, type Template } from "@/hooks/use-templates";

type UseAgentHotkeysArgs = {
  agents: Agent[];
  isMobile: boolean;
  sidebarAgentId: string | null;
  validatedSelectedAgentId: string | null;
  canFocusTerminal: boolean;
  focusTerminal: () => void;
  mediaOpen: boolean;
  setMediaOpen: (open: boolean) => void;
  leftPanelOpen: boolean;
  handleSetLeftPanelOpen: (open: boolean) => void;
  openCreateDialog: () => void;
};

export type UseAgentHotkeysResult = {
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  paletteActions: CommandAction[];
  paletteGroups: CommandGroup[];
  launchTemplate: Template | null;
  setLaunchTemplateId: (id: string | null) => void;
};

/**
 * Wires every agent-view hotkey + the Cmd+K command palette in one place.
 * Returns the palette open state and action list to render. Hotkey effects
 * register internally — the caller only owns the rendered <CommandPalette />.
 */
export function useAgentHotkeys({
  agents,
  isMobile,
  sidebarAgentId,
  validatedSelectedAgentId,
  canFocusTerminal,
  focusTerminal,
  mediaOpen,
  setMediaOpen,
  leftPanelOpen,
  handleSetLeftPanelOpen,
  openCreateDialog,
}: UseAgentHotkeysArgs): UseAgentHotkeysResult {
  const navigate = useNavigate();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [launchTemplateId, setLaunchTemplateId] = useState<string | null>(null);
  const { data: templates = [] } = useTemplates();

  useHotkey("open-command-palette", () => setPaletteOpen((v) => !v));
  useHotkey(
    "focus-terminal-input",
    () => {
      if (!canFocusTerminal) return;
      focusTerminal();
    },
    { enabled: !isMobile && canFocusTerminal }
  );

  useHotkey("toggle-media-sidebar", () => {
    if (!isMobile && !sidebarAgentId) return;
    setMediaOpen(!mediaOpen);
  });

  useHotkey("toggle-agent-sidebar", () => {
    handleSetLeftPanelOpen(!leftPanelOpen);
  });

  const cycleAgent = useCallback(
    (direction: -1 | 1) => {
      // Cycling walks the sidebar cards, and a sub agent has no card of its own.
      const cycleAgents = partitionAgentsByLineage(agents).topLevel;
      if (cycleAgents.length === 0) return;
      const currentIdx = validatedSelectedAgentId
        ? cycleAgents.findIndex((a) => a.id === validatedSelectedAgentId)
        : -1;
      const nextIdx =
        currentIdx === -1
          ? direction === 1
            ? 0
            : cycleAgents.length - 1
          : (currentIdx + direction + cycleAgents.length) % cycleAgents.length;
      navigate(agentRoute(cycleAgents[nextIdx].id));
    },
    [agents, navigate, validatedSelectedAgentId]
  );

  useHotkey("focus-prev-agent", () => cycleAgent(-1));
  useHotkey("focus-next-agent", () => cycleAgent(1));

  const paletteActions = useMemo<CommandAction[]>(
    () => [
      {
        id: "new-agent",
        title: "New agent",
        keywords: ["create", "spawn", "add"],
        icon: Plus,
        run: () => openCreateDialog(),
      },
      {
        id: "keyboard-shortcuts",
        title: "Keyboard shortcuts",
        keywords: [
          "shortcut",
          "hotkey",
          "terminal",
          "sidebar",
          "focus",
          "help",
        ],
        icon: Keyboard,
        run: () => navigate("/settings/help/shortcuts"),
      },
    ],
    [navigate, openCreateDialog]
  );

  const paletteGroups = useMemo<CommandGroup[]>(() => {
    const callableTemplates = templates.filter((t) => t.callable);
    if (callableTemplates.length === 0) return [];
    return [
      {
        label: "Templates",
        actions: callableTemplates.map((template) => ({
          id: `template-${template.id}`,
          title: template.name,
          keywords: ["template", "launch", "run"],
          icon: Play,
          run: () => {
            setPaletteOpen(false);
            setLaunchTemplateId(template.id);
          },
        })),
      },
    ];
  }, [templates, setPaletteOpen, setLaunchTemplateId]);

  const resolvedLaunchTemplate = useMemo(
    () => templates.find((t) => t.id === launchTemplateId) ?? null,
    [templates, launchTemplateId]
  );

  return {
    paletteOpen,
    setPaletteOpen,
    paletteActions,
    paletteGroups,
    launchTemplate: resolvedLaunchTemplate,
    setLaunchTemplateId,
  };
}
