// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  interactionStateFromError,
  interactionStateFromResponse,
  useKeyedInteractionState,
  useResetOnRevisionChange,
  useSingleInteractionState,
} from "./local-interaction-state";
import type { SurfaceInteractionResponse } from "@/components/app/agent-surfaces/types";

afterEach(() => {
  cleanup();
});

function response(
  status: "queued" | "notified",
  outcomeMessage?: string
): SurfaceInteractionResponse {
  return {
    interaction: { id: "ix_1", status, outcomeMessage },
    delivery: status === "notified" ? "notified" : "queued",
    duplicate: false,
  };
}

describe("interactionStateFromResponse", () => {
  it("maps a notified delivery to the notified state", () => {
    expect(interactionStateFromResponse(response("notified", "on it"))).toEqual(
      {
        status: "notified",
        interactionId: "ix_1",
        message: "on it",
      }
    );
  });

  it("maps a queued delivery to queued", () => {
    expect(interactionStateFromResponse(response("queued"))).toEqual({
      status: "queued",
      interactionId: "ix_1",
      message: undefined,
    });
  });

  it("keys off delivery, not interaction.status — an idempotent replay of an already-completed interaction still reports notified", () => {
    const replay: SurfaceInteractionResponse = {
      interaction: { id: "ix_1", status: "completed", outcomeMessage: "Done." },
      delivery: "notified",
      duplicate: true,
    };
    expect(interactionStateFromResponse(replay)).toEqual({
      status: "notified",
      interactionId: "ix_1",
      message: "Done.",
    });
  });

  it("carries the returned interaction id, which is what decides local-vs-durable freshness", () => {
    const state = interactionStateFromResponse({
      interaction: { id: "ix_42", status: "queued" },
      delivery: "queued",
      duplicate: false,
    });
    expect(state).toMatchObject({ status: "queued", interactionId: "ix_42" });
  });
});

describe("interactionStateFromError", () => {
  it("uses the error message when present", () => {
    expect(
      interactionStateFromError(new Error("network down"), "fallback")
    ).toEqual({
      status: "error",
      message: "network down",
    });
  });

  it("falls back when the error has no message", () => {
    expect(interactionStateFromError(new Error(""), "fallback")).toEqual({
      status: "error",
      message: "fallback",
    });
  });
});

describe("useResetOnRevisionChange", () => {
  it("fires onReset only when the revision actually changes", () => {
    const onReset = vi.fn();
    const { rerender } = renderHook(
      ({ revision }) => useResetOnRevisionChange(revision, onReset),
      { initialProps: { revision: 1 } }
    );

    rerender({ revision: 1 });
    expect(onReset).not.toHaveBeenCalled();

    rerender({ revision: 2 });
    expect(onReset).toHaveBeenCalledTimes(1);
  });
});

describe("useSingleInteractionState", () => {
  it("goes submitting -> queued/notified via the mutate callback, and resets on revision bump", () => {
    const mutate = vi.fn(
      (
        _request,
        handlers: { onSuccess: (r: SurfaceInteractionResponse) => void }
      ) => {
        handlers.onSuccess(response("notified", "done"));
      }
    );
    const { result, rerender } = renderHook(
      ({ revision }) => useSingleInteractionState(revision, mutate),
      { initialProps: { revision: 1 } }
    );

    act(() => {
      result.current.submit(
        {
          idempotencyKey: "k",
          kind: "action",
          blockId: "b",
          actionId: "a",
          baseRevision: 1,
        },
        "fallback"
      );
    });

    expect(result.current.state).toEqual({
      status: "notified",
      interactionId: "ix_1",
      message: "done",
    });

    rerender({ revision: 2 });
    expect(result.current.state).toEqual({ status: "idle" });
  });

  it("maps a failed mutate call to the error state", () => {
    const mutate = vi.fn(
      (_request, handlers: { onError: (e: Error) => void }) => {
        handlers.onError(new Error("boom"));
      }
    );
    const { result } = renderHook(() => useSingleInteractionState(1, mutate));

    act(() => {
      result.current.submit(
        {
          idempotencyKey: "k",
          kind: "action",
          blockId: "b",
          actionId: "a",
          baseRevision: 1,
        },
        "fallback"
      );
    });

    expect(result.current.state).toEqual({
      status: "error",
      message: "boom",
    });
  });

  it("reset() returns to idle without waiting for a revision bump", () => {
    const mutate = vi.fn(
      (
        _request,
        handlers: { onSuccess: (r: SurfaceInteractionResponse) => void }
      ) => handlers.onSuccess(response("queued"))
    );
    const { result } = renderHook(() => useSingleInteractionState(1, mutate));

    act(() => {
      result.current.submit(
        {
          idempotencyKey: "k",
          kind: "action",
          blockId: "b",
          actionId: "a",
          baseRevision: 1,
        },
        "fallback"
      );
    });
    expect(result.current.state.status).toBe("queued");

    act(() => result.current.reset());
    expect(result.current.state).toEqual({ status: "idle" });
  });
});

describe("useKeyedInteractionState", () => {
  it("tracks independent state per key and resets all keys together on a revision bump", () => {
    const mutateA = vi.fn(
      (_r, handlers: { onSuccess: (r: SurfaceInteractionResponse) => void }) =>
        handlers.onSuccess(response("queued", "a queued"))
    );
    const { result, rerender } = renderHook(
      ({ revision }) => useKeyedInteractionState(revision, mutateA),
      { initialProps: { revision: 1 } }
    );

    act(() => {
      result.current.submit(
        "action-a",
        {
          idempotencyKey: "k1",
          kind: "action",
          blockId: "b",
          actionId: "action-a",
          baseRevision: 1,
        },
        "fallback"
      );
    });

    expect(result.current.states["action-a"]).toEqual({
      status: "queued",
      interactionId: "ix_1",
      message: "a queued",
    });

    rerender({ revision: 2 });
    expect(result.current.states).toEqual({});
  });

  it("reports a failed submit for its own key only", () => {
    const mutateB = vi.fn((_r, handlers: { onError: (e: Error) => void }) =>
      handlers.onError(new Error("b failed"))
    );
    const { result } = renderHook(() => useKeyedInteractionState(1, mutateB));

    act(() => {
      result.current.submit(
        "action-b",
        {
          idempotencyKey: "k2",
          kind: "action",
          blockId: "b",
          actionId: "action-b",
          baseRevision: 1,
        },
        "fallback"
      );
    });

    expect(result.current.states["action-b"]).toEqual({
      status: "error",
      message: "b failed",
    });
  });

  it("clear() drops just the one key", () => {
    const mutate = vi.fn(
      (_r, handlers: { onSuccess: (r: SurfaceInteractionResponse) => void }) =>
        handlers.onSuccess(response("queued"))
    );
    const { result } = renderHook(() => useKeyedInteractionState(1, mutate));

    act(() => {
      result.current.submit(
        "a",
        {
          idempotencyKey: "k",
          kind: "action",
          blockId: "b",
          actionId: "a",
          baseRevision: 1,
        },
        "fallback"
      );
    });
    expect(result.current.states.a).toBeDefined();

    act(() => result.current.clear("a"));
    expect(result.current.states.a).toBeUndefined();
  });
});
