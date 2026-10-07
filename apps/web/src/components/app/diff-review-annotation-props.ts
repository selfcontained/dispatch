import type {
  Block,
  BlockFindingPatch,
  BlockFindingData,
  BlockFindingState,
} from "@dispatch/shared";

import type { DraftComment } from "@/components/app/review-mode";

/** One review finding placed in the diff: the finding, its record, its review. */
export type DiffFinding = {
  /** The finding block's id: unique across every review in the stream. */
  key: string;
  block: Extract<Block, { kind: "review" }>;
  /** The finding block: its thread is the finding's discussion. */
  findingId: string;
  finding: BlockFindingData;
  record: BlockFindingState | null;
  /** Who left the review. */
  reviewerName: string;
};

/**
 * Review findings shown inline in the diff at their lines, with the ways
 * to act on them: open the finding's page in the drawer, or change its
 * status here. Grouped so every level of the diff forwards one prop.
 */
export type DiffFindingsProps = {
  items: DiffFinding[];
  /** A finding to expand and scroll to, from the URL. */
  focusedKey: string | null;
  onFocusComplete: (key: string) => void;
  /** Opens the finding's thread over the thread its review is shown in. */
  onOpen: (threadId: string, findingId: string) => void;
  onSetState?: (findingId: string, patch: BlockFindingPatch) => void;
  /** Status changes cannot be sent right now. */
  disabled: boolean;
  /** An agent's name, for who left or changed a finding. */
  nameOf: (agentId: string) => string;
};

/**
 * The review props threaded from the changes tab down through the diff
 * pane, each file section, the unified diff view and finally the widget
 * hook. Every level in that chain forwards the same optional block, so it is
 * declared once here and intersected into each component's own props.
 */
export type DiffReviewAnnotationProps = {
  reviewMode?: boolean;
  draftComments?: DraftComment[];
  onAddDraft?: (
    filePath: string,
    startLine: number,
    endLine: number,
    comment: string
  ) => void;
  onRemoveDraft?: (id: string) => void;
  onUpdateDraft?: (id: string, comment: string) => void;
  onStartReview?: () => void;
  findings?: DiffFindingsProps;
};
