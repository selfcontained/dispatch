import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type {
  ReviewFeedbackItemRecord,
  ReviewListItem as ReviewListItemRecord,
  ReviewRecord,
  ReviewThreadMessageRecord,
  ReviewWithItems as ReviewWithItemsRecord,
} from "../../../server/src/agents/reviews";
import { api } from "@/lib/api";

export type ReviewThreadMessage = ReviewThreadMessageRecord;

export type ReviewFeedbackItem = ReviewFeedbackItemRecord & {
  messages: ReviewThreadMessage[];
};

export type Review = ReviewRecord;

export type ReviewListItem = ReviewListItemRecord;

export type ReviewWithItems = ReviewWithItemsRecord;

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

function invalidateReviewQueries(
  queryClient: ReturnType<typeof useQueryClient>,
  agentId: string
) {
  void queryClient.invalidateQueries({ queryKey: reviewsQueryKey(agentId) });
  void queryClient.invalidateQueries({
    predicate: (query) =>
      query.queryKey[0] === "agent-review-detail" &&
      query.queryKey[1] === agentId,
  });
  void queryClient.invalidateQueries({
    queryKey: feedbackItemsQueryKey(agentId),
  });
}

export function useAddReviewThreadMessage(agentId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ itemId, body }: { itemId: number; body: string }) => {
      const response = await api<{ message: ReviewThreadMessage }>(
        `/api/v1/agents/${agentId}/reviews/items/${itemId}/messages`,
        { method: "POST", body: JSON.stringify({ body }) }
      );
      return response.message;
    },
    onSuccess: () => {
      if (agentId) invalidateReviewQueries(queryClient, agentId);
    },
  });
}

export function useSetReviewFeedbackResolution(agentId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      itemId,
      resolution,
    }: {
      itemId: number;
      resolution: "fixed" | "dismissed" | null;
    }) => {
      const response = await api<{ item: ReviewFeedbackItem }>(
        `/api/v1/agents/${agentId}/reviews/items/${itemId}`,
        { method: "PATCH", body: JSON.stringify({ resolution }) }
      );
      return response.item;
    },
    onSuccess: () => {
      if (agentId) invalidateReviewQueries(queryClient, agentId);
    },
  });
}

function feedbackItemsQueryKey(agentId: string): [string, string] {
  return ["agent-feedback-items", agentId];
}

export function useAllReviewFeedbackItems(
  agentId: string | null,
  enabled: boolean
): ReviewFeedbackItem[] {
  const query = useQuery<ReviewFeedbackItem[]>({
    queryKey: feedbackItemsQueryKey(agentId ?? ""),
    queryFn: async () => {
      const resp = await api<{ items: ReviewFeedbackItem[] }>(
        `/api/v1/agents/${agentId}/reviews/feedback-items`
      );
      return resp.items;
    },
    enabled: enabled && !!agentId,
    staleTime: 10_000,
  });

  return query.data ?? [];
}
