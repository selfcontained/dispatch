// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useTipQueue } from "./tip-queue-context";
import { TipQueueProvider } from "./tip-queue-provider";

type QueueHandle = ReturnType<typeof useTipQueue>;

function Capture({ handle }: { handle: { current: QueueHandle | null } }) {
  handle.current = useTipQueue();
  return null;
}

function renderQueue() {
  const handle: { current: QueueHandle | null } = { current: null };
  render(
    <TipQueueProvider>
      <Capture handle={handle} />
    </TipQueueProvider>
  );
  return handle as { current: QueueHandle };
}

afterEach(cleanup);

describe("TipQueueProvider", () => {
  it("grants the first instance and denies a second instance of the same tip", () => {
    const queue = renderQueue();

    let first = false;
    act(() => {
      first = queue.current.requestOpen("review-row-open", "instance-a");
    });
    expect(first).toBe(true);

    let second = true;
    act(() => {
      second = queue.current.requestOpen("review-row-open", "instance-b");
    });
    expect(second).toBe(false);

    // The owner keeps its grant on re-request (effect re-runs).
    let ownerAgain = false;
    act(() => {
      ownerAgain = queue.current.requestOpen("review-row-open", "instance-a");
    });
    expect(ownerAgain).toBe(true);
  });

  it("does not hand the same tip to another instance after the owner releases", () => {
    const queue = renderQueue();

    act(() => {
      queue.current.requestOpen("review-row-open", "instance-a");
    });
    act(() => {
      queue.current.requestOpen("review-row-open", "instance-b");
    });
    act(() => {
      queue.current.release("review-row-open", "instance-a");
    });

    expect(queue.current.activeTipId).toBeNull();
  });

  it("queues a different tip and grants it after release", () => {
    const queue = renderQueue();

    act(() => {
      queue.current.requestOpen("review-row-open", "instance-a");
    });
    let other = true;
    act(() => {
      other = queue.current.requestOpen("split-tabs", "instance-c");
    });
    expect(other).toBe(false);

    act(() => {
      queue.current.release("review-row-open", "instance-a");
    });
    expect(queue.current.activeTipId).toBe("split-tabs");

    let granted = false;
    act(() => {
      granted = queue.current.requestOpen("split-tabs", "instance-c");
    });
    expect(granted).toBe(true);
  });

  it("ignores a release from a non-owning instance", () => {
    const queue = renderQueue();

    act(() => {
      queue.current.requestOpen("review-row-open", "instance-a");
    });
    act(() => {
      queue.current.release("review-row-open", "instance-b");
    });

    expect(queue.current.activeTipId).toBe("review-row-open");
  });
});
