import { type ReactNode, useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import {
  type FeedContext,
  type PeerDirectory,
  peerDirectory,
} from "@/components/app/chat/chat-entries";
import { type PinShortcutState } from "@/components/app/chat/pin-shortcut-context";
import { useShortcutRunner } from "@/components/app/pin-shortcut-runner";
import { type Agent, type AgentPin } from "@/components/app/types";
import { useRunPinShortcut } from "@/hooks/use-pin-shortcuts";
import { api } from "@/lib/api";

export type ChatFeedContextInput = {
  agentId: string | null;
  agent: Agent | null;
  openLightbox: (mediaId: number) => void;
  onOpenReview?: (reviewId: number) => void;
};

export type ChatFeedContextResult = {
  /** Feed-wide identity: the memo key of every row. */
  ctx: FeedContext;
  /** What the pin rows read; changes without touching `ctx`. */
  pinShortcuts: PinShortcutState;
  /** The shortcut confirmation dialog; render it once in the pane. */
  shortcutDialog: ReactNode;
};

/**
 * The two contexts the feed's rows read, built so that each keeps its
 * identity until something it carries actually changes.
 *
 * Every row is memoised on `ctx`, so the rules that keep it stable live
 * here, in one place:
 *
 * - `agent` is a fresh object on every `agent.upsert`; only the scalar
 *   fields the feed shows are dependencies, never the record.
 * - The peer directory comes from the agents query through a stable
 *   selector, so react-query hands back the previous value when nothing
 *   in it changed.
 * - Mutation result objects are new on every render; callbacks depend on
 *   the stable `mutate` and the `isPending` flag, never the object.
 * - Pins, the pending shortcut and the running flag are the pin rows'
 *   business and travel on `pinShortcuts` instead, keyed by content so an
 *   upsert that changed nothing there changes nothing here.
 */
export function useChatFeedContext({
  agentId,
  agent,
  openLightbox,
  onOpenReview,
}: ChatFeedContextInput): ChatFeedContextResult {
  // Every agent.upsert hands over a fresh pins array; key on its content so
  // unchanged pins don't invalidate the pin rows.
  const pinsKey = JSON.stringify(agent?.pins ?? []);
  const pins = useMemo<AgentPin[]>(() => JSON.parse(pinsKey), [pinsKey]);

  // Shortcut pins in the stream fire exactly as they do in the sidebar:
  // same confirmation rule, same dialog, same focus restoration.
  const runPinShortcut = useRunPinShortcut();
  const { mutate: runShortcutNow, isPending: shortcutPending } = runPinShortcut;
  const fireShortcut = useCallback(
    (pin: AgentPin) => {
      if (!agentId || !pin.id || shortcutPending) return;
      runShortcutNow({ agentId, pinId: pin.id, label: pin.label });
    },
    [agentId, runShortcutNow, shortcutPending]
  );
  const shortcuts = useShortcutRunner(fireShortcut);
  const { request: requestShortcut, registerButton: registerShortcutButton } =
    shortcuts;
  const onRunShortcut = useCallback(
    (pin: AgentPin, pointerType?: string) =>
      requestShortcut(pin, pointerType, null),
    [requestShortcut]
  );
  const pendingPinId = shortcutPending
    ? (runPinShortcut.variables?.pinId ?? null)
    : null;
  const agentIsRunning = agent?.status === "running";
  const workspaceRoot = agent?.worktreePath ?? agent?.cwd ?? null;
  const pinShortcuts = useMemo<PinShortcutState>(
    () => ({
      pins,
      workspaceRoot,
      agentIsRunning,
      pendingPinId,
      onRunShortcut,
      registerShortcutButton,
    }),
    [
      agentIsRunning,
      onRunShortcut,
      pendingPinId,
      pins,
      registerShortcutButton,
      workspaceRoot,
    ]
  );

  // The sidebar's agent list, read for a peer post's icon and lineage.
  // `select` narrows it to what the feed shows, so structural sharing keeps
  // the directory's identity across agent updates that change nothing here;
  // a stable selector lets react-query skip re-running it at all.
  const selectPeers = useCallback(
    (agents: Agent[]) => peerDirectory(agentId ?? "", agents),
    [agentId]
  );
  const { data: peers } = useQuery<Agent[], Error, PeerDirectory>({
    queryKey: ["agents"],
    queryFn: async () => {
      const payload = await api<{ agents: Agent[] }>("/api/v1/agents");
      return payload.agents;
    },
    select: selectPeers,
  });

  const agentName = agent?.name;
  const agentType = agent?.type ?? null;
  const ctx = useMemo<FeedContext>(
    () => ({
      agentId: agentId ?? "",
      agentName,
      agentType,
      peers,
      onOpenMedia: openLightbox,
      onOpenReview,
    }),
    [agentId, agentName, agentType, onOpenReview, openLightbox, peers]
  );

  return { ctx, pinShortcuts, shortcutDialog: shortcuts.dialog };
}
