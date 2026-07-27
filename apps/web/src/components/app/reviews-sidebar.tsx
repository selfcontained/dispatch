import { memo, useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { MessageCircle } from "lucide-react";

import { useAgentReviews } from "@/hooks/use-agent-reviews";
import { useAgentDiff } from "@/hooks/use-agent-diff";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ReviewRow } from "@/components/app/reviews-sidebar-row";

type ReviewsSidebarContentProps = {
  agentId: string | null;
  onNavigateToFile?: (
    filePath: string,
    lineStart: number | null,
    feedbackItemId?: number
  ) => void;
};

export const ReviewsSidebarContent = memo(function ReviewsSidebarContent({
  agentId,
  onNavigateToFile,
}: ReviewsSidebarContentProps): JSX.Element {
  const { reviews, isLoading } = useAgentReviews(agentId, !!agentId);
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: diffData } = useAgentDiff(agentId, !!agentId);
  const requestedReviewId = Number(searchParams.get("expandReview"));
  const expandedReviewId =
    Number.isInteger(requestedReviewId) && requestedReviewId > 0
      ? requestedReviewId
      : null;
  const setExpandedReviewId = useCallback(
    (reviewId: number | null) => {
      setSearchParams((previous) => {
        const next = new URLSearchParams(previous);
        if (reviewId == null) next.delete("expandReview");
        else next.set("expandReview", String(reviewId));
        return next;
      });
    },
    [setSearchParams]
  );

  const diffFilePaths = useMemo(() => {
    if (!diffData?.files) return undefined;
    return new Set(diffData.files.map((f) => f.path));
  }, [diffData]);

  if (!agentId) {
    return (
      <div className="grid h-full place-items-center p-4 text-center text-sm text-muted-foreground">
        Focus an agent to view reviews.
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8 text-xs text-muted-foreground">
        Loading reviews…
      </div>
    );
  }

  if (reviews.length === 0) {
    return (
      <div className="grid h-full place-items-center p-4 text-center text-sm text-muted-foreground">
        <div className="flex flex-col items-center gap-2">
          <MessageCircle className="h-8 w-8 text-muted-foreground" />
          <p>No reviews yet</p>
          <p className="text-xs">
            Open the Changes tab and use &quot;Start review&quot; to submit
            feedback.
          </p>
        </div>
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={200}>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2.5">
        {reviews.map((review) => (
          <ReviewRow
            key={review.id}
            agentId={agentId}
            review={review}
            expanded={expandedReviewId === review.id}
            onToggle={() =>
              setExpandedReviewId(
                expandedReviewId === review.id ? null : review.id
              )
            }
            onNavigateToFile={onNavigateToFile}
            diffFilePaths={diffFilePaths}
          />
        ))}
      </div>
    </TooltipProvider>
  );
});
