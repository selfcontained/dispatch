import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowDown,
  ArrowUp,
  PanelLeft,
  PanelLeftOpen,
  PanelRight,
  PanelRightOpen,
  Play,
  Plus,
} from "lucide-react";
import { toast } from "sonner";

import {
  type CommandAction,
  type CommandGroup,
} from "@/components/app/command-palette";
import { type Agent } from "@/components/app/types";
import { agentRoute } from "@/lib/agent-routes";
import { useHotkey } from "@/lib/hotkeys/use-hotkey";
import {
  useTemplates,
  useTemplateActions,
  parseTemplateArgs,
} from "@/hooks/use-templates";
import { useQueryClient } from "@tanstack/react-query";

type UseAgentHotkeysArgs = {
  agents: Agent[];
  isMobile: boolean;
  sidebarAgentId: string | null;
  validatedSelectedAgentId: string | null;
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
  mediaOpen,
  setMediaOpen,
  leftPanelOpen,
  handleSetLeftPanelOpen,
  openCreateDialog,
}: UseAgentHotkeysArgs): UseAgentHotkeysResult {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const { data: templates = [] } = useTemplates();
  const { launchTemplate } = useTemplateActions();

  useHotkey("open-command-palette", () => setPaletteOpen((v) => !v));

  useHotkey("toggle-media-sidebar", () => {
    if (!isMobile && !sidebarAgentId) return;
    setMediaOpen(!mediaOpen);
  });

  useHotkey("toggle-agent-sidebar", () => {
    handleSetLeftPanelOpen(!leftPanelOpen);
  });

  const cycleAgent = useCallback(
    (direction: -1 | 1) => {
      const cycleAgents = agents.filter((a) => !a.parentAgentId);
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
        id: "toggle-media-sidebar",
        title: "Toggle media sidebar",
        keywords: ["pins", "media", "right"],
        hotkey: "toggle-media-sidebar",
        icon: mediaOpen ? PanelRight : PanelRightOpen,
        disabled: !isMobile && !sidebarAgentId,
        run: () => {
          if (!isMobile && !sidebarAgentId) return;
          setMediaOpen(!mediaOpen);
        },
      },
      {
        id: "toggle-agent-sidebar",
        title: "Toggle agent sidebar",
        keywords: ["agents", "left", "list"],
        hotkey: "toggle-agent-sidebar",
        icon: leftPanelOpen ? PanelLeft : PanelLeftOpen,
        run: () => handleSetLeftPanelOpen(!leftPanelOpen),
      },
      {
        id: "focus-next-agent",
        title: "Focus next agent",
        keywords: ["cycle", "switch", "down"],
        hotkey: "focus-next-agent",
        icon: ArrowDown,
        run: () => cycleAgent(1),
      },
      {
        id: "focus-prev-agent",
        title: "Focus previous agent",
        keywords: ["cycle", "switch", "up"],
        hotkey: "focus-prev-agent",
        icon: ArrowUp,
        run: () => cycleAgent(-1),
      },
    ],
    [
      cycleAgent,
      handleSetLeftPanelOpen,
      isMobile,
      leftPanelOpen,
      mediaOpen,
      openCreateDialog,
      setMediaOpen,
      sidebarAgentId,
    ]
  );

  const paletteGroups = useMemo<CommandGroup[]>(() => {
    const callableTemplates = templates.filter((t) => t.callable);
    if (callableTemplates.length === 0) return [];
    return [
      {
        label: "Templates",
        actions: callableTemplates.map((template) => {
          const args = parseTemplateArgs(template.prompt ?? "");
          const hasArgs = args.length > 0;
          return {
            id: `template-${template.id}`,
            title: template.name,
            keywords: ["template", "launch", "run"],
            icon: Play,
            confirm: hasArgs
              ? undefined
              : {
                  description:
                    "This will create a new agent from this template.",
                },
            run: () => {
              if (hasArgs) {
                navigate(`/automations/templates/${template.id}`);
                return;
              }
              launchTemplate
                .mutateAsync({ id: template.id })
                .then(async (result) => {
                  await queryClient.invalidateQueries({
                    queryKey: ["agents"],
                  });
                  navigate(agentRoute(result.agentId));
                })
                .catch((err: Error) => {
                  toast.error(`Failed to launch template: ${err.message}`);
                });
            },
          };
        }),
      },
    ];
  }, [templates, launchTemplate, navigate, queryClient]);

  return { paletteOpen, setPaletteOpen, paletteActions, paletteGroups };
}
