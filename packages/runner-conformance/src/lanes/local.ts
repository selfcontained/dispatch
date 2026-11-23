/*
 * Local lane: the compiled local runner child, started through its launcher
 * pipe and reached over its local socket. Neither exists yet (L1 adds the
 * child and launcher, L2 the socket), so the lane cannot start and every
 * scenario is a red baseline entry until they land.
 */
import { spawnLocalRunner } from "../reference-client.js";
import { LaneUnavailable, type Lane } from "../run.js";

export async function startLocalLane(): Promise<Lane> {
  try {
    await spawnLocalRunner();
  } catch (error) {
    throw new LaneUnavailable((error as Error).message);
  }
  throw new LaneUnavailable("The local runner child has no fixture yet (L1).");
}
