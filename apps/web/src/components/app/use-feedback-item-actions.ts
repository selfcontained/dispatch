import { useState, type FormEvent } from "react";
import { toast } from "sonner";

import {
  useAddReviewThreadMessage,
  useSetReviewFeedbackResolution,
} from "@/hooks/use-agent-reviews";

export type FeedbackResolution = "fixed" | "dismissed" | null;

// Reply-draft state and the two review-feedback mutations, shared by the
// in-diff annotation and the reviews sidebar row. Only the behaviour is
// shared — the two cards render completely different markup.
export function useFeedbackItemActions(
  agentId: string | null,
  itemId: number
): {
  reply: string;
  setReply: (value: string) => void;
  replying: boolean;
  startReply: () => void;
  cancelReply: () => void;
  submitReply: (event: FormEvent) => Promise<void>;
  isSendingReply: boolean;
  updateResolution: (resolution: FeedbackResolution) => Promise<void>;
  isUpdatingResolution: boolean;
  pendingResolution: FeedbackResolution | undefined;
} {
  const [reply, setReply] = useState("");
  const [replying, setReplying] = useState(false);
  const addMessage = useAddReviewThreadMessage(agentId);
  const setResolution = useSetReviewFeedbackResolution(agentId);

  const submitReply = async (event: FormEvent) => {
    event.preventDefault();
    const body = reply.trim();
    if (!body) return;
    try {
      await addMessage.mutateAsync({ itemId, body });
      setReply("");
      setReplying(false);
    } catch {
      toast.error("Couldn't send the reply. Try again.");
    }
  };

  const cancelReply = () => {
    setReply("");
    setReplying(false);
  };

  const updateResolution = async (resolution: FeedbackResolution) => {
    try {
      await setResolution.mutateAsync({ itemId, resolution });
    } catch {
      toast.error("Couldn't update the feedback state. Try again.");
    }
  };

  return {
    reply,
    setReply,
    replying,
    startReply: () => setReplying(true),
    cancelReply,
    submitReply,
    isSendingReply: addMessage.isPending,
    updateResolution,
    isUpdatingResolution: setResolution.isPending,
    pendingResolution: setResolution.variables?.resolution,
  };
}
