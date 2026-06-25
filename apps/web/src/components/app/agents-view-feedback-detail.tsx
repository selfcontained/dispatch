import { type FeedbackDetailState } from "@/components/app/feedback-utils";
import {
  FeedbackDetailPanel,
  MobileFeedbackSheet,
  MobileReviewSummarySheet,
  ReviewSummaryPanel,
} from "@/components/app/feedback-panel";
import { type Agent } from "@/components/app/types";

type FeedbackDetailProps = {
  detail: NonNullable<FeedbackDetailState>;
  agents: Agent[];
  connectedAgentId: string | null;
  sendTerminalInput: (data: string) => void;
  onClose: () => void;
  onNavigateItem: (parentAgentId: string, nextItemId: number) => void;
};

export function DesktopFeedbackDetail({
  detail,
  agents,
  connectedAgentId,
  sendTerminalInput,
  onClose,
  onNavigateItem,
}: FeedbackDetailProps): JSX.Element | null {
  if ("summaryAgentId" in detail) {
    const summaryAgent = agents.find((a) => a.id === detail.summaryAgentId);
    return summaryAgent ? (
      <ReviewSummaryPanel
        key={`summary-${detail.summaryAgentId}`}
        parentAgentId={detail.parentAgentId}
        agent={summaryAgent}
        onClose={onClose}
      />
    ) : null;
  }

  return (
    <FeedbackDetailPanel
      key={detail.parentAgentId}
      parentAgentId={detail.parentAgentId}
      itemId={detail.itemId}
      isConnected={connectedAgentId === detail.parentAgentId}
      sendTerminalInput={sendTerminalInput}
      onClose={onClose}
      onNavigate={(nextItemId) =>
        onNavigateItem(detail.parentAgentId, nextItemId)
      }
    />
  );
}

export function MobileFeedbackDetail({
  detail,
  agents,
  connectedAgentId,
  sendTerminalInput,
  onClose,
  onNavigateItem,
}: FeedbackDetailProps): JSX.Element | null {
  if ("summaryAgentId" in detail) {
    const summaryAgent = agents.find((a) => a.id === detail.summaryAgentId);
    return summaryAgent ? (
      <MobileReviewSummarySheet
        parentAgentId={detail.parentAgentId}
        agent={summaryAgent}
        onClose={onClose}
      />
    ) : null;
  }

  return (
    <MobileFeedbackSheet
      parentAgentId={detail.parentAgentId}
      itemId={detail.itemId}
      isConnected={connectedAgentId === detail.parentAgentId}
      sendTerminalInput={sendTerminalInput}
      onClose={onClose}
      onNavigate={(nextItemId) =>
        onNavigateItem(detail.parentAgentId, nextItemId)
      }
    />
  );
}
