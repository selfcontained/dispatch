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

import {
  type CommandAction,
  type CommandGroup,
} from "@/components/app/command-palette";
import { type Agent } from "@/components/app/types";
import { agentRoute } from "@/lib/agent-routes";
import { useHotkey } from "@/lib/hotkeys/use-hotkey";
import { type Job, useJobActions } from "@/hooks/use-jobs";
import { useQueryClient } from "@tanstack/react-query";

type UseAgentHotkeysArgs = {
  agents: Agent[];
  jobs: Job[];
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
  jobs,
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
  const { runNow } = useJobActions();

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
    const callableJobs = jobs.filter((j) => j.callable);
    if (callableJobs.length === 0) return [];
    return [
      {
        label: "Jobs",
        actions: callableJobs.map((job) => ({
          id: `job-${job.id}`,
          title: job.name,
          keywords: ["job", "run", "launch"],
          icon: Play,
          run: () => {
            runNow.mutateAsync(job).then(async (result) => {
              await queryClient.invalidateQueries({ queryKey: ["agents"] });
              if (result.agentId) {
                navigate(agentRoute(result.agentId));
              }
            });
          },
        })),
      },
    ];
  }, [jobs, runNow, navigate, queryClient]);

  return { paletteOpen, setPaletteOpen, paletteActions, paletteGroups };
}
