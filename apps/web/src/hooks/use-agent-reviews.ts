import { useCallback, useMemo } from "react";
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { api } from "@/lib/api";

export type ReviewThreadMessage = {
  id: number;
  feedbackItemId: number;
  authorType: string;
  authorAgentId: string | null;
  type: string;
  content: { body: string };
  createdAt: string;
};

export type ReviewFeedbackItem = {
  id: number;
  reviewId: number;
  filePath: string | null;
  lineStart: number | null;
  lineEnd: number | null;
  diffSnapshot: string | null;
  baseRef: string | null;
  status: string;
  resolution: string | null;
  resolutionNote: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  messages: ReviewThreadMessage[];
};

export type Review = {
  id: number;
  agentId: string;
  assignedAgentId: string | null;
  reviewerType: string;
  reviewerAgentId: string | null;
  summary: string | null;
  status: string;
  baseRef: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ReviewListItem = Review & {
  itemCount: number;
  resolvedCount: number;
};

export type ReviewWithItems = Review & {
  items: ReviewFeedbackItem[];
};

export type SubmitReviewInput = {
  summary?: string;
  items: Array<{
    filePath?: string;
    startLine?: number;
    endLine?: number;
    comment: string;
  }>;
};

function reviewsQueryKey(agentId: string): [string, string] {
  return ["agent-reviews", agentId];
}

function reviewDetailQueryKey(
  agentId: string,
  reviewId: number
): [string, string, number] {
  return ["agent-review-detail", agentId, reviewId];
}

export function useAgentReviews(agentId: string | null, enabled: boolean) {
  const queryClient = useQueryClient();

  const query = useQuery<ReviewListItem[]>({
    queryKey: reviewsQueryKey(agentId ?? ""),
    queryFn: async () => {
      const resp = await api<{ reviews: ReviewListItem[] }>(
        `/api/v1/agents/${agentId}/reviews`
      );
      return resp.reviews;
    },
    enabled: enabled && !!agentId,
    staleTime: 10_000,
    refetchOnWindowFocus: true,
  });

  const invalidate = useCallback(() => {
    if (agentId) {
      void queryClient.invalidateQueries({
        queryKey: reviewsQueryKey(agentId),
      });
    }
  }, [agentId, queryClient]);

  return { reviews: query.data ?? [], isLoading: query.isLoading, invalidate };
}

export function useAgentReviewDetail(
  agentId: string | null,
  reviewId: number | null,
  enabled: boolean
) {
  const query = useQuery<ReviewWithItems>({
    queryKey: reviewDetailQueryKey(agentId ?? "", reviewId ?? 0),
    queryFn: async () => {
      const resp = await api<{ review: ReviewWithItems }>(
        `/api/v1/agents/${agentId}/reviews/${reviewId}`
      );
      return resp.review;
    },
    enabled: enabled && !!agentId && reviewId !== null,
    staleTime: 10_000,
  });

  return { review: query.data ?? null, isLoading: query.isLoading };
}

export function useSubmitReview(agentId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: SubmitReviewInput) => {
      const resp = await api<{ review: ReviewWithItems }>(
        `/api/v1/agents/${agentId}/reviews`,
        {
          method: "POST",
          body: JSON.stringify(input),
        }
      );
      return resp.review;
    },
    onSuccess: (newReview) => {
      if (agentId) {
        void queryClient.refetchQueries({
          queryKey: reviewsQueryKey(agentId),
        });
        queryClient.setQueryData(
          reviewDetailQueryKey(agentId, newReview.id),
          newReview
        );
      }
    },
  });
}

export function useAllReviewFeedbackItems(
  agentId: string | null,
  enabled: boolean
): ReviewFeedbackItem[] {
  const { reviews } = useAgentReviews(agentId, enabled);

  const detailQueries = useQueries({
    queries: reviews.map((r) => ({
      queryKey: reviewDetailQueryKey(agentId ?? "", r.id),
      queryFn: async () => {
        const resp = await api<{ review: ReviewWithItems }>(
          `/api/v1/agents/${agentId}/reviews/${r.id}`
        );
        return resp.review;
      },
      enabled: enabled && !!agentId,
      staleTime: 10_000,
    })),
  });

  return useMemo(
    () => detailQueries.flatMap((q) => q.data?.items ?? []),
    [detailQueries]
  );
}
