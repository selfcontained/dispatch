import React from "react";
import { useNavigate } from "react-router-dom";
import {
  Archive,
  ClipboardCheck,
  ClipboardList,
  Copy,
  FolderInput,
  Info,
  MoreHorizontal,
  Pause,
  Pencil,
  Pin,
  PinOff,
  Play,
} from "lucide-react";

import { ChangeWorkspaceDialog } from "@/components/app/change-workspace-dialog";
import { useIdeLaunchOptions } from "@/components/app/ide-launch";
import { PersonaLauncher } from "@/components/app/persona-launcher";
import { type Agent } from "@/components/app/types";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { RowButton } from "@/components/ui/row-button";
import { Sheet, SheetHeader } from "@/components/ui/sheet";
import { toast } from "@/components/ui/toast";
import { useTouchPhone } from "@/hooks/use-coarse-pointer";
import { useCopyText } from "@/hooks/use-copy";
import { type AgentType } from "@/lib/agent-types";
import { type IdeType } from "@/lib/ide-types";
import { cn } from "@/lib/utils";

export type AgentActionsProps = {
  agent: Agent;
  isStopped: boolean;
  /** Sub agents that archive along with it, named on the menu item. */
  cascadeCount: number;
  enabledAgentTypes: AgentType[];
  enabledIdes: IdeType[];
  onPause: () => void;
  onEditSettings: () => void;
  onArchive: () => void;
};

export type AgentCardActionsProps = AgentActionsProps & {
  isPinned: boolean;
  onTogglePin?: (agentId: string) => void;
};

type Group = { key: string; label?: string; items: Item[] };
type Item = {
  key: string;
  icon: JSX.Element;
  text: string;
  reason?: string;
  disabled?: boolean;
  danger?: boolean;
  onSelect: () => void;
};

function archiveDisabled(agent: Agent): boolean {
  return agent.status === "archiving" || agent.status === "creating";
}

/**
 * Footer of an expanded agent card. Archive is the one action used often, so
 * it keeps a button; everything else is rare and sits in the ⋯ menu, which
 * always comes last in the row. The menu repeats Archive so every action is
 * in one place.
 */
export function AgentCardActions(
  props: AgentCardActionsProps
): JSX.Element | null {
  const { agent, cascadeCount, onArchive } = props;
  // A reviewer's lifecycle belongs to the agent that launched it; its card
  // only offers pinning.
  if (agent.role === "review")
    return props.onTogglePin ? (
      <div className="flex min-h-9 items-center justify-end">
        <AgentActionsMenu {...props} variant="card" />
      </div>
    ) : null;
  return (
    <div className="flex min-h-9 items-center justify-end gap-1">
      <Button
        size="sm"
        variant="ghost"
        className="text-muted-foreground hover:text-danger"
        disabled={archiveDisabled(agent)}
        data-testid={`agent-archive-${agent.id}`}
        aria-label={
          cascadeCount > 0
            ? `Archive (with ${cascadeCount} sub agents)`
            : "Archive"
        }
        onClick={onArchive}
      >
        <Archive />
        Archive
      </Button>
      <AgentActionsMenu {...props} variant="card" />
    </div>
  );
}

/**
 * Every action for one agent, grouped: Session, Workspace, then Archive. A
 * dropdown under a fine pointer, a bottom sheet on touch. The card's footer
 * and each sub agent's row use the same menu; a sub agent's adds Resume (its
 * row has no header play button) and opens its full details instead of the
 * rename form, since its card is never expanded.
 */
export function AgentActionsMenu({
  agent,
  isStopped,
  isPinned = false,
  onTogglePin,
  cascadeCount,
  enabledAgentTypes,
  enabledIdes,
  onPause,
  onEditSettings,
  onArchive,
  variant,
  onResume,
  onOpenReview,
  onChangeWorkspace,
}: AgentActionsProps & {
  variant: "card" | "subagent";
  isPinned?: boolean;
  onTogglePin?: (agentId: string) => void;
  onResume?: () => void;
  /** Set when the sub agent has submitted a review. */
  onOpenReview?: () => void;
  /**
   * Opens a Change workspace dialog its owner renders. A sub agent's row can
   * unmount while collapsed, so the card owns that dialog; without this the
   * menu renders its own.
   */
  onChangeWorkspace?: () => void;
}): JSX.Element {
  // A bottom sheet on a phone; a dropdown everywhere else, tablets included.
  const asSheet = useTouchPhone();
  const navigate = useNavigate();
  const [sheetOpen, setSheetOpen] = React.useState(false);
  const [workspaceOpen, setWorkspaceOpen] = React.useState(false);
  const [reviewSignal, setReviewSignal] = React.useState(0);
  const [reviewUnavailable, setReviewUnavailable] = React.useState<
    string | null
  >(null);
  const [pathCopied, copyPath] = useCopyText();
  const dir = agent.workspacePath ?? agent.cwd;
  const ideOptions = useIdeLaunchOptions(dir, enabledIdes);
  const isReviewer = agent.role === "review";
  const archiving = agent.status === "archiving";
  const subagent = variant === "subagent";
  const canLaunchReview = variant === "card" && !isReviewer;

  React.useEffect(() => {
    if (pathCopied) toast.success("Worktree path copied.");
  }, [pathCopied]);

  const pinItem: Item | null = onTogglePin
    ? {
        key: "pin",
        icon: isPinned ? <PinOff /> : <Pin />,
        text: isPinned ? "Unpin" : "Pin to top",
        onSelect: () => onTogglePin(agent.id),
      }
    : null;

  const session: Item[] = [];
  if (onOpenReview)
    session.push({
      key: "open-review",
      icon: <ClipboardList />,
      text: "Open review",
      onSelect: onOpenReview,
    });
  if (canLaunchReview)
    session.push({
      key: "review",
      icon: <ClipboardCheck />,
      text: "Start a review…",
      reason: isStopped
        ? "Agent stopped"
        : reviewUnavailable
          ? reviewUnavailable.startsWith("Loading")
            ? "Loading…"
            : reviewUnavailable.startsWith("Launching")
              ? "Launching…"
              : "Unavailable"
          : undefined,
      disabled: isStopped || archiving || reviewUnavailable !== null,
      onSelect: () => setReviewSignal((n) => n + 1),
    });
  if (pinItem) session.push(pinItem);
  if (!isStopped && !archiving)
    session.push({
      key: "pause",
      icon: <Pause />,
      text: "Pause…",
      onSelect: onPause,
    });
  if (isStopped && !archiving && onResume)
    session.push({
      key: "resume",
      icon: <Play />,
      text: "Resume",
      onSelect: onResume,
    });
  session.push(
    subagent
      ? {
          key: "details",
          icon: <Info />,
          text: "Details & rename…",
          onSelect: onEditSettings,
        }
      : {
          key: "rename",
          icon: <Pencil />,
          text: "Rename / project…",
          onSelect: onEditSettings,
        }
  );

  const workspace: Item[] = [];
  if (agent.gitContext?.isWorktree && dir)
    workspace.push({
      key: "copy",
      icon: <Copy />,
      text: "Copy worktree path",
      onSelect: () => copyPath(dir),
    });
  workspace.push({
    key: "move",
    icon: <FolderInput />,
    text: "Change workspace…",
    onSelect: onChangeWorkspace ?? (() => setWorkspaceOpen(true)),
  });
  for (const option of ideOptions)
    workspace.push({
      key: option.key,
      icon: option.icon,
      text: option.label,
      reason: option.reason,
      disabled: option.disabled,
      onSelect: () => {
        option.onSelect?.();
        if (option.href) window.location.href = option.href;
        else if (option.to) navigate(option.to);
      },
    });

  const archiveItem: Item = {
    key: "archive",
    icon: <Archive />,
    text: "Archive…",
    reason:
      cascadeCount > 0
        ? `+ ${cascadeCount} sub agent${cascadeCount === 1 ? "" : "s"}`
        : undefined,
    danger: true,
    disabled: archiveDisabled(agent),
    onSelect: onArchive,
  };

  // A reviewer card's lifecycle belongs to the agent that launched it.
  const groups: Group[] =
    variant === "card" && isReviewer
      ? [{ key: "session", items: pinItem ? [pinItem] : [] }]
      : [
          { key: "session", label: "Session", items: session },
          { key: "workspace", label: "Workspace", items: workspace },
          { key: "archive", items: [archiveItem] },
        ];

  const testId = subagent
    ? `sub-agent-menu-${agent.id}`
    : `agent-more-${agent.id}`;
  const itemTestId = (key: string) =>
    subagent ? `sub-agent-action-${key}-${agent.id}` : `agent-action-${key}`;

  const trigger = (
    <IconButton
      size={subagent ? "icon-xs" : undefined}
      label={subagent ? `Actions for ${agent.name}` : "More actions"}
      className={subagent ? "text-faint hover:text-foreground" : undefined}
      data-agent-control="true"
      data-testid={testId}
      onClick={asSheet ? () => setSheetOpen(true) : undefined}
    >
      <MoreHorizontal />
    </IconButton>
  );

  return (
    <>
      {asSheet ? (
        <>
          {trigger}
          <Sheet
            open={sheetOpen}
            onOpenChange={setSheetOpen}
            side="bottom"
            keepMounted={false}
            label={`${agent.name} actions`}
          >
            <SheetHeader
              title={agent.name}
              onClose={() => setSheetOpen(false)}
            />
            <div
              className="flex flex-col overflow-y-auto px-2 pb-[max(env(safe-area-inset-bottom),12px)] pt-1"
              data-agent-control="true"
            >
              {groups.map((group, index) => (
                <div
                  key={group.key}
                  className={cn(
                    index > 0 && "mt-1 border-t border-border-subtle pt-1"
                  )}
                >
                  {group.label ? (
                    <div className="section-label px-3 pb-1 pt-2">
                      {group.label}
                    </div>
                  ) : null}
                  {group.items.map((item) => (
                    <RowButton
                      key={item.key}
                      disabled={item.disabled}
                      data-testid={itemTestId(item.key)}
                      className={cn(
                        "min-h-12 px-3 text-body-md [&>svg]:size-icon-md",
                        item.danger ? "text-danger" : "text-foreground"
                      )}
                      onClick={() => {
                        setSheetOpen(false);
                        item.onSelect();
                      }}
                    >
                      {item.icon}
                      <span>{item.text}</span>
                      {item.reason ? (
                        <span className="ml-auto text-label-sm text-faint">
                          {item.reason}
                        </span>
                      ) : null}
                    </RowButton>
                  ))}
                </div>
              ))}
            </div>
          </Sheet>
        </>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
          {/* Portaled out of the row, so it carries its own control marker
              for the row's click-to-open guard. */}
          <DropdownMenuContent
            align="end"
            className="w-72"
            data-agent-control="true"
          >
            {groups.map((group, index) => (
              <React.Fragment key={group.key}>
                {index > 0 ? <DropdownMenuSeparator /> : null}
                {group.label ? (
                  <div className="section-label px-2 pb-1 pt-1.5">
                    {group.label}
                  </div>
                ) : null}
                {group.items.map((item) => (
                  <DropdownMenuItem
                    key={item.key}
                    disabled={item.disabled}
                    data-testid={itemTestId(item.key)}
                    onSelect={item.onSelect}
                    className={cn(
                      "flex items-center gap-2 disabled-state [&>svg]:size-icon-md",
                      item.danger ? "text-danger" : "text-foreground"
                    )}
                  >
                    {item.icon}
                    <span>{item.text}</span>
                    {item.reason ? (
                      <span className="ml-auto text-label-xs text-faint">
                        {item.reason}
                      </span>
                    ) : null}
                  </DropdownMenuItem>
                ))}
              </React.Fragment>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {onChangeWorkspace ? null : (
        <ChangeWorkspaceDialog
          agent={agent}
          open={workspaceOpen}
          onOpenChange={setWorkspaceOpen}
        />
      )}
      {canLaunchReview ? (
        <PersonaLauncher
          agent={agent}
          enabledAgentTypes={enabledAgentTypes}
          openSignal={reviewSignal}
          onUnavailableChange={setReviewUnavailable}
          hideTrigger
        />
      ) : null}
    </>
  );
}
