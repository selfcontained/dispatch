import type { RunnerUpdateHolds } from "../../src/agents/remote/update-hold.js";

/**
 * What a test can await of the work holds run in the background. Create it
 * before the manager, so a release is recorded before the manager resumes it.
 */
export function trackHoldWork(holds: RunnerUpdateHolds) {
  const unsettled = new Map<
    string,
    ReturnType<typeof Promise.withResolvers<void>>
  >();
  const track = (launches: { id: string }[]) => {
    for (const { id } of launches)
      unsettled.set(id, Promise.withResolvers<void>());
  };
  holds.onRelease(({ launches }) => track(launches));
  holds.onResume(track);
  const settleLaunch = holds.settleLaunch.bind(holds);
  holds.settleLaunch = async (id) => {
    try {
      await settleLaunch(id);
    } finally {
      unsettled.get(id)?.resolve();
      unsettled.delete(id);
    }
  };
  const blocked = Promise.withResolvers<void>();
  const wait = holds.wait.bind(holds);
  holds.wait = (runnerId, kind) => {
    const waited = wait(runnerId, kind);
    if (holds.isHeld(runnerId)) blocked.resolve();
    return waited;
  };
  return {
    /** Something is waiting for a hold to open. */
    blocked: blocked.promise,
    /** Every resumed launch reached its outcome and that outcome was saved. */
    async settled() {
      // `start` hands recovered launches to its listeners in a microtask.
      await new Promise((resolve) => setImmediate(resolve));
      while (unsettled.size)
        await Promise.all([...unsettled.values()].map((work) => work.promise));
    },
    /** This controller died: what it was driving never settles. */
    abandon: () => unsettled.clear(),
  };
}
