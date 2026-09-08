// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useFeedbackItemActions } from "./use-feedback-item-actions";

const addMessage = {
  mutateAsync: vi.fn(),
  isPending: false,
};
const setResolution = {
  mutateAsync: vi.fn(),
  isPending: false,
  variables: undefined as
    | { resolution: "fixed" | "dismissed" | null }
    | undefined,
};

vi.mock("@/hooks/use-agent-reviews", () => ({
  useAddReviewThreadMessage: () => addMessage,
  useSetReviewFeedbackResolution: () => setResolution,
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const { toast } = await import("sonner");
const toastError = vi.mocked(toast.error);

/** A submit event stand-in that records preventDefault. */
function formEvent() {
  return { preventDefault: vi.fn() } as unknown as React.FormEvent & {
    preventDefault: ReturnType<typeof vi.fn>;
  };
}

beforeEach(() => {
  addMessage.mutateAsync = vi.fn(async () => undefined);
  addMessage.isPending = false;
  setResolution.mutateAsync = vi.fn(async () => undefined);
  setResolution.isPending = false;
  setResolution.variables = undefined;
  toastError.mockClear();
});

afterEach(cleanup);

describe("useFeedbackItemActions", () => {
  it("sends the trimmed reply for the given item and resets the draft", async () => {
    const { result } = renderHook(() => useFeedbackItemActions("agt_1", 42));

    act(() => result.current.startReply());
    act(() => result.current.setReply("  looks good  "));
    expect(result.current.replying).toBe(true);
    expect(result.current.reply).toBe("  looks good  ");

    await act(async () => {
      await result.current.submitReply(formEvent());
    });

    expect(addMessage.mutateAsync).toHaveBeenCalledWith({
      itemId: 42,
      body: "looks good",
    });
    expect(result.current.reply).toBe("");
    expect(result.current.replying).toBe(false);
  });

  it("does not send a blank reply and leaves the form open", async () => {
    const { result } = renderHook(() => useFeedbackItemActions("agt_1", 42));

    act(() => result.current.startReply());
    act(() => result.current.setReply("   "));
    const event = formEvent();
    await act(async () => {
      await result.current.submitReply(event);
    });

    expect(event.preventDefault).toHaveBeenCalled();
    expect(addMessage.mutateAsync).not.toHaveBeenCalled();
    expect(result.current.replying).toBe(true);
    expect(result.current.reply).toBe("   ");
  });

  it("keeps the draft and toasts when sending the reply fails", async () => {
    addMessage.mutateAsync = vi.fn(async () => {
      throw new Error("boom");
    });
    const { result } = renderHook(() => useFeedbackItemActions("agt_1", 42));

    act(() => result.current.startReply());
    act(() => result.current.setReply("retry me"));
    await act(async () => {
      await result.current.submitReply(formEvent());
    });

    expect(toastError).toHaveBeenCalledWith(
      "Couldn't send the reply. Try again."
    );
    expect(result.current.reply).toBe("retry me");
    expect(result.current.replying).toBe(true);
  });

  it("clears the draft on cancel", () => {
    const { result } = renderHook(() => useFeedbackItemActions("agt_1", 42));

    act(() => result.current.startReply());
    act(() => result.current.setReply("never mind"));
    act(() => result.current.cancelReply());

    expect(result.current.reply).toBe("");
    expect(result.current.replying).toBe(false);
  });

  it("updates the resolution for the given item", async () => {
    const { result } = renderHook(() => useFeedbackItemActions("agt_1", 7));

    await act(async () => {
      await result.current.updateResolution("fixed");
    });

    expect(setResolution.mutateAsync).toHaveBeenCalledWith({
      itemId: 7,
      resolution: "fixed",
    });
    expect(toastError).not.toHaveBeenCalled();
  });

  it("toasts when updating the resolution fails", async () => {
    setResolution.mutateAsync = vi.fn(async () => {
      throw new Error("boom");
    });
    const { result } = renderHook(() => useFeedbackItemActions("agt_1", 7));

    await act(async () => {
      await result.current.updateResolution(null);
    });

    expect(toastError).toHaveBeenCalledWith(
      "Couldn't update the feedback state. Try again."
    );
  });

  it("surfaces the mutation pending flags and the in-flight resolution", () => {
    addMessage.isPending = true;
    setResolution.isPending = true;
    setResolution.variables = { resolution: "dismissed" };

    const { result } = renderHook(() => useFeedbackItemActions("agt_1", 7));

    expect(result.current.isSendingReply).toBe(true);
    expect(result.current.isUpdatingResolution).toBe(true);
    expect(result.current.pendingResolution).toBe("dismissed");
  });
});
