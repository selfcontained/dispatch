import { type ComponentProps } from "react";

import { LaunchTemplateDialog } from "@/components/app/automations-launch-dialog";
import {
  CommandPalette,
  type CommandAction,
  type CommandGroup,
} from "@/components/app/command-palette";
import { CreateAgentDialog } from "@/components/app/create-agent-dialog";
import { DeleteAgentDialog } from "@/components/app/delete-agent-dialog";
import { MediaLightbox } from "@/components/app/media-lightbox";
import { StopAgentDialog } from "@/components/app/stop-agent-dialog";
import { type Agent } from "@/components/app/types";
import { type Template } from "@/hooks/use-templates";
import { type AgentType, isCliAgentType } from "@/lib/agent-types";

type AgentsViewDialogsProps = {
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  paletteActions: CommandAction[];
  paletteGroups: CommandGroup[];
  launchTemplate: Template | null;
  setLaunchTemplateId: (id: string | null) => void;
  enabledAgentTypes: AgentType[];
  createOpen: boolean;
  initialAgentType: AgentType | null;
  onCreateOpenChange: (open: boolean) => void;
  resolveCreateDefaultCwd: () => string;
  onAgentCreated: (agent: Agent, agentType: AgentType) => Promise<void>;
  deleteConfirmOpen: boolean;
  deleteTarget: Agent | null;
  agents: Agent[];
  setDeleteConfirmOpen: (open: boolean) => void;
  setDeleteTarget: (agent: Agent | null) => void;
  onDelete: (agent: Agent, cleanupWorktree?: string) => Promise<void>;
  stopConfirmOpen: boolean;
  stopTarget: Agent | null;
  setStopConfirmOpen: (open: boolean) => void;
  setStopTarget: (agent: Agent | null) => void;
  onStop: (agent: Agent) => Promise<void>;
  lightboxItem: ComponentProps<typeof MediaLightbox>["item"];
  lightboxIndex: number;
  mediaFileCount: number;
  setLightboxIndex: (nextIndex: number | null) => void;
};

/**
 * The modal/overlay cluster rendered at the end of the agents view: command
 * palette, template launch dialog, create/delete/stop agent dialogs, and the
 * media lightbox. Purely presentational — all state lives in the parent.
 */
export function AgentsViewDialogs({
  paletteOpen,
  setPaletteOpen,
  paletteActions,
  paletteGroups,
  launchTemplate,
  setLaunchTemplateId,
  enabledAgentTypes,
  createOpen,
  initialAgentType,
  onCreateOpenChange,
  resolveCreateDefaultCwd,
  onAgentCreated,
  deleteConfirmOpen,
  deleteTarget,
  agents,
  setDeleteConfirmOpen,
  setDeleteTarget,
  onDelete,
  stopConfirmOpen,
  stopTarget,
  setStopConfirmOpen,
  setStopTarget,
  onStop,
  lightboxItem,
  lightboxIndex,
  mediaFileCount,
  setLightboxIndex,
}: AgentsViewDialogsProps): JSX.Element {
  return (
    <>
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        actions={paletteActions}
        groups={paletteGroups}
      />

      {launchTemplate ? (
        <LaunchTemplateDialog
          template={launchTemplate}
          open={!!launchTemplate}
          onOpenChange={(open) => {
            if (!open) setLaunchTemplateId(null);
          }}
          agentTypes={enabledAgentTypes.filter(isCliAgentType)}
        />
      ) : null}

      <CreateAgentDialog
        open={createOpen}
        enabledAgentTypes={enabledAgentTypes}
        initialAgentType={initialAgentType}
        setOpen={onCreateOpenChange}
        resolveDefaultCwd={resolveCreateDefaultCwd}
        onCreated={onAgentCreated}
      />

      <DeleteAgentDialog
        open={deleteConfirmOpen}
        deleteTarget={deleteTarget}
        agents={agents}
        setOpen={setDeleteConfirmOpen}
        setDeleteTarget={setDeleteTarget}
        onDelete={onDelete}
      />

      <StopAgentDialog
        open={stopConfirmOpen}
        stopTarget={stopTarget}
        setOpen={setStopConfirmOpen}
        setStopTarget={setStopTarget}
        onStop={onStop}
      />

      <MediaLightbox
        item={lightboxItem}
        currentIndex={lightboxIndex}
        totalItems={mediaFileCount}
        setLightboxIndex={setLightboxIndex}
      />
    </>
  );
}
