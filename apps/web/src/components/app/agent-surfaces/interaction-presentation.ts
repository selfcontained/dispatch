import type {
  SurfaceInteractionStatus,
  SurfaceInteractionSummary,
  Tone,
} from "@/components/app/agent-surfaces/types";
import type { LocalInteractionState } from "@/components/app/agent-surfaces/local-interaction-state";

/**
 * How a control settles once its interaction reaches a terminal status.
 * Distinct from the block type because a form's `submitMode` changes the
 * answer: see `terminalPresentation` for the per-mode rules.
 */
export type InteractionMode = "action" | "form-once" | "form-repeatable";

export type PendingInteractionStatus = Extract<
  SurfaceInteractionStatus,
  "queued" | "notified" | "claimed"
>;

export type TerminalInteractionStatus = Exclude<
  SurfaceInteractionStatus,
  PendingInteractionStatus
>;

/**
 * What the footer under an action/submit button should say. Kept as data
 * rather than JSX so the state machine below is testable without rendering,
 * and so the caption component stays a dumb renderer.
 */
export type InteractionCaption =
  | {
      kind: "pending";
      status: PendingInteractionStatus;
      label: string;
      message?: string;
    }
  | {
      kind: "outcome";
      status: TerminalInteractionStatus;
      label: string;
      tone: Tone;
      message?: string;
    }
  | { kind: "error"; message: string };

export type InteractionPresentation = {
  /** Show the button's spinner — a submission is in flight from this tab. */
  busy: boolean;
  /** Natively disable the control: submitting, still pending, or settled. */
  locked: boolean;
  caption: InteractionCaption | null;
};

const PENDING_STATUSES: readonly PendingInteractionStatus[] = [
  "queued",
  "notified",
  "claimed",
];

export function isPendingStatus(
  status: SurfaceInteractionStatus
): status is PendingInteractionStatus {
  return (PENDING_STATUSES as readonly string[]).includes(status);
}

/**
 * Caption wording, one entry per durable status. `label` leads the sentence
 * and is what a screen reader announces first; `fallback` fills in for the
 * agent's own `outcomeMessage` when it didn't supply one, so a caption is
 * never a bare status word with no explanation of what happens next.
 */
const PENDING_COPY: Record<
  PendingInteractionStatus,
  { label: string; fallback: string }
> = {
  queued: { label: "Queued", fallback: "waiting for the agent" },
  notified: { label: "Sent to the agent", fallback: "waiting for a response" },
  claimed: { label: "In progress", fallback: "the agent is handling this" },
};

const OUTCOME_COPY: Record<
  TerminalInteractionStatus,
  { label: string; tone: Tone; fallback?: string }
> = {
  completed: { label: "Completed", tone: "success" },
  rejected: {
    label: "Declined",
    tone: "danger",
    fallback: "the agent declined this",
  },
  cancelled: {
    label: "Cancelled",
    tone: "neutral",
    fallback: "this was cancelled",
  },
  orphaned: {
    label: "Not handled",
    tone: "warning",
    fallback: "the agent ended before handling this",
  },
};

function pendingCaption(
  status: PendingInteractionStatus,
  message: string | undefined
): InteractionCaption {
  const copy = PENDING_COPY[status];
  return {
    kind: "pending",
    status,
    label: copy.label,
    message: message ?? copy.fallback,
  };
}

function outcomeCaption(
  status: TerminalInteractionStatus,
  message: string | undefined
): InteractionCaption {
  const copy = OUTCOME_COPY[status];
  // `completed` has no fallback: "Completed." on its own is a complete
  // sentence, whereas a declined or orphaned interaction needs to say why.
  const detail = message ?? copy.fallback;
  return {
    kind: "outcome",
    status,
    label: copy.label,
    tone: copy.tone,
    ...(detail ? { message: detail } : {}),
  };
}

/**
 * Whether a control re-arms once its interaction has finished.
 *
 * Rejected, cancelled and orphaned always re-arm, in every mode: nothing was
 * applied, so an immediate retry is the useful affordance. Migration 0043's
 * `agent_surface_interactions_once_form_idx` is unique on
 * `(surface_id, once_form_block_id)` only `WHERE status IN ('queued',
 * 'notified', 'claimed', 'completed')`, so re-arming a once-form after one of
 * those three is a submission the server will actually accept.
 *
 * Completed is where the modes diverge:
 * - a **once-form** stays locked permanently — the partial index still covers
 *   `completed`, so a second submission is a guaranteed 409;
 * - a **repeatable form** re-arms, since submitting again is the point;
 * - an **action** stays settled while the document still shows the revision
 *   it was completed against, then re-arms once the agent moves the document
 *   forward.
 *
 * The outcome caption is retained either way — re-arming a control must
 * never be what erases the agent's explanation of what happened.
 */
function terminalPresentation(
  summary: SurfaceInteractionSummary,
  status: TerminalInteractionStatus,
  mode: InteractionMode,
  surfaceRevision: number,
  readOnly: boolean
): InteractionPresentation {
  const caption = outcomeCaption(status, summary.outcomeMessage);
  if (readOnly) return { busy: false, locked: true, caption };
  if (status !== "completed") return { busy: false, locked: false, caption };
  const locked =
    mode === "form-once" ||
    (mode === "action" && summary.tabRevision === surfaceRevision);
  return { busy: false, locked, caption };
}

/**
 * Merges the durable server record for one action/submit with this tab's
 * local submission state into what the control should render.
 *
 * The durable summary is the source of truth — that is what makes pending
 * and settled state survive a reload or a sheet remount (product review
 * #2016) and what lets a resolved outcome reach the user at all (#2015).
 * Local state only covers what the server payload cannot yet know: an
 * in-flight POST, a POST that failed, and the gap between a successful POST
 * and the refetch that reflects it.
 *
 * Interaction changes emit SSE but deliberately do not bump the surface
 * revision, so freshness between the two sources is decided by interaction
 * id, never by revision.
 */
export function resolveInteractionPresentation({
  local,
  durable,
  surfaceRevision,
  mode,
  readOnly,
}: {
  local: LocalInteractionState;
  durable: SurfaceInteractionSummary | undefined;
  surfaceRevision: number;
  mode: InteractionMode;
  readOnly: boolean;
}): InteractionPresentation {
  if (local.status === "submitting") {
    return { busy: true, locked: true, caption: null };
  }

  // A durable record that is still in flight outranks everything else,
  // including a local error: a POST whose response was lost still created
  // the interaction, and re-arming on the error would submit it twice.
  if (durable && isPendingStatus(durable.status)) {
    return {
      busy: false,
      locked: true,
      caption: pendingCaption(durable.status, durable.outcomeMessage),
    };
  }

  if (local.status === "error") {
    return {
      busy: false,
      locked: readOnly,
      caption: { kind: "error", message: local.message },
    };
  }

  const localSettled = local.status === "queued" || local.status === "notified";

  // Durable wins unless the local overlay describes a *newer* submission
  // than the payload has caught up to — which is exactly when the ids differ.
  // The pending case already returned, so re-testing it here is only what
  // narrows `durableStatus` to the terminal statuses without a cast.
  const durableStatus = durable?.status;
  if (
    durable &&
    durableStatus &&
    !isPendingStatus(durableStatus) &&
    (!localSettled || durable.id === local.interactionId)
  ) {
    return terminalPresentation(
      durable,
      durableStatus,
      mode,
      surfaceRevision,
      readOnly
    );
  }

  if (localSettled) {
    return {
      busy: false,
      locked: true,
      caption: pendingCaption(local.status, local.message),
    };
  }

  return { busy: false, locked: readOnly, caption: null };
}

/**
 * `Surface.latestInteractions` indexed by the pair it is keyed on
 * server-side, so a block can find its own record in constant time instead
 * of scanning the array once per action.
 */
export type SurfaceInteractionIndex = ReadonlyMap<
  string,
  SurfaceInteractionSummary
>;

function interactionKey(
  blockId: string,
  actionId: string,
  itemId?: string
): string {
  return [blockId, itemId ?? "", actionId].join("\\0");
}

export function indexInteractions(
  summaries: readonly SurfaceInteractionSummary[] | undefined
): SurfaceInteractionIndex {
  const index = new Map<string, SurfaceInteractionSummary>();
  for (const summary of summaries ?? []) {
    index.set(
      interactionKey(summary.blockId, summary.actionId, summary.itemId),
      summary
    );
  }
  return index;
}

export function findInteraction(
  index: SurfaceInteractionIndex,
  blockId: string,
  actionId: string,
  itemId?: string
): SurfaceInteractionSummary | undefined {
  return index.get(interactionKey(blockId, actionId, itemId));
}
