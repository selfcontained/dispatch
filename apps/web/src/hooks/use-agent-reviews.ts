import { useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import type {
  Review,
  ReviewFeedbackItem,
  ReviewThreadMessage,
} from "@/components/app/types";

/** A feedback item enriched with reviewer context, for inline annotations. */
export type FeedbackItemAnnotation = Omit<ReviewFeedbackItem, "messages"> & {
  reviewerType: "human" | "agent";
  firstMessage: ReviewThreadMessage | null;
};

export function agentReviewsQueryKey(agentId: string): string[] {
  return ["agent-reviews", agentId];
}

export function agentFeedbackItemsQueryKey(agentId: string): string[] {
  return ["agent-reviews", agentId, "feedback"];
}

export function agentReviewDetailQueryKey(
  agentId: string,
  reviewId: string
): string[] {
  return ["agent-reviews", agentId, reviewId];
}

type ReviewListResponse = {
  reviews: Review[];
};

type ReviewDetailResponse = {
  review: Review;
};

type SubmitReviewInput = {
  summary?: string;
  items: {
    filePath?: string;
    startLine?: number;
    endLine?: number;
    comment: string;
  }[];
};

export function useAgentReviews(
  agentId: string | null,
  enabled = true
): {
  data: Review[] | undefined;
  isLoading: boolean;
  refresh: () => void;
} {
  const queryClient = useQueryClient();

  const query = useQuery<Review[]>({
    queryKey: agentReviewsQueryKey(agentId ?? ""),
    queryFn: async () => {
      const res = await api<ReviewListResponse>(
        `/api/v1/agents/${agentId}/reviews`
      );
      return res.reviews;
    },
    enabled: enabled && !!agentId,
    staleTime: 10_000,
  });

  const refresh = useCallback(() => {
    if (agentId) {
      void queryClient.invalidateQueries({
        queryKey: agentReviewsQueryKey(agentId),
      });
    }
  }, [agentId, queryClient]);

  return { data: query.data, isLoading: query.isLoading, refresh };
}

export function useAgentReviewDetail(
  agentId: string | null,
  reviewId: string | null,
  enabled = true
): {
  data: Review | undefined;
  isLoading: boolean;
} {
  const query = useQuery<Review>({
    queryKey: agentReviewDetailQueryKey(agentId ?? "", reviewId ?? ""),
    queryFn: async () => {
      const res = await api<ReviewDetailResponse>(
        `/api/v1/agents/${agentId}/reviews/${reviewId}`
      );
      return res.review;
    },
    enabled: enabled && !!agentId && !!reviewId,
    staleTime: 10_000,
  });

  return { data: query.data, isLoading: query.isLoading };
}

export function useSubmitReview(agentId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: SubmitReviewInput) => {
      if (!agentId) throw new Error("No agent selected");
      const res = await api<ReviewDetailResponse>(
        `/api/v1/agents/${agentId}/reviews`,
        {
          method: "POST",
          body: JSON.stringify(input),
        }
      );
      return res.review;
    },
    onSuccess: () => {
      if (agentId) {
        void queryClient.invalidateQueries({
          queryKey: agentReviewsQueryKey(agentId),
        });
      }
    },
  });
}

/**
 * Fetch all feedback items across all reviews for an agent.
 * Used by the diff view to render inline annotations at file/line ranges.
 */
export function useAgentFeedbackItems(
  agentId: string | null,
  enabled = true
): {
  data: FeedbackItemAnnotation[] | undefined;
  isLoading: boolean;
} {
  type FeedbackListResponse = { items: FeedbackItemAnnotation[] };

  const query = useQuery<FeedbackItemAnnotation[]>({
    queryKey: agentFeedbackItemsQueryKey(agentId ?? ""),
    queryFn: async () => {
      const res = await api<FeedbackListResponse>(
        `/api/v1/agents/${agentId}/reviews/feedback`
      );
      return res.items;
    },
    enabled: enabled && !!agentId,
    staleTime: 10_000,
  });

  return { data: query.data, isLoading: query.isLoading };
}
