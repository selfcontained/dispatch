import type { Duplex } from "node:stream";
import { LocalSocketConnection } from "@dispatch/runner-client/transport/local-socket";
import {
  RUNNER_WIRE_VERSION,
  parseRunnerHealth,
  parseSelfUpdateAdvert,
  type RunnerHealth,
  type SelfUpdateAdvert,
  type UpdateStatusFrame,
} from "@dispatch/runner-protocol";
import {
  parseEngineInventory,
  type EngineInventoryEntry,
} from "@dispatch/runner-protocol/engine-management";
import {
  runnerIdFromWire,
  type RunnerDescription,
} from "@dispatch/runner-protocol/contract";

export type OperationPeer = {
  connection: LocalSocketConnection;
  epoch: number;
  approved(): boolean;
  description: RunnerDescription;
  selfUpdate?: SelfUpdateAdvert;
};

type Callbacks = {
  connected(peer: OperationPeer): void;
  current(peer: OperationPeer): boolean;
  disconnected(peer: OperationPeer): void;
  status(peer: OperationPeer, status: UpdateStatusFrame): void;
  health(peer: OperationPeer, sample: RunnerHealth): void;
  inventory(peer: OperationPeer, entries: EngineInventoryEntry[]): void;
};

/** Start after the listener has authenticated the runner's registration and certificate. */
export function attachAuthenticatedRunner(
  socket: Duplex,
  registration: { id: string; name: string; approved(): boolean },
  epoch: number,
  events: Callbacks
) {
  let peer: OperationPeer | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let samplingHealth = false;
  let samplingInventory = false;
  const active = (): OperationPeer | undefined =>
    peer &&
    registration.approved() &&
    events.current(peer) &&
    peer.connection.connected
      ? peer
      : undefined;
  const connection = LocalSocketConnection.fromAuthenticatedSocket(
    socket,
    (status) => {
      const observed = () => {
        const current = active();
        if (!current || !current.selfUpdate) {
          socket.destroy();
          return;
        }
        events.status(current, status);
        if (status.phase === "confirmed") void health();
      };
      // The first description and the observation following it can arrive
      // in one socket read. Let the description's promise register the peer.
      if (peer) observed();
      else setImmediate(observed);
    }
  );
  async function health() {
    const current = active();
    if (!current || samplingHealth) return;
    samplingHealth = true;
    try {
      const value = await connection.call("runner.health", {});
      if (!active()) return;
      const sample = parseRunnerHealth(value);
      if (!sample) {
        socket.destroy();
        return;
      }
      events.health(current, sample);
    } catch {
      // One missed sample leaves the latest observation available.
    } finally {
      samplingHealth = false;
    }
  }
  async function inventory() {
    const current = active();
    if (!current || samplingInventory) return;
    samplingInventory = true;
    try {
      const value = await connection.call("engine.list", {
        refresh: false,
        background: true,
      });
      if (!active()) return;
      const entries = parseEngineInventory(value.entries);
      if (!entries) {
        socket.destroy();
        return;
      }
      events.inventory(current, entries);
    } catch {
      // The protected update fence can defer the workload probes.
    } finally {
      samplingInventory = false;
    }
  }
  connection.onClose(() => {
    clearInterval(timer);
    if (peer) events.disconnected(peer);
  });
  void connection
    .call("runner.describe", {}, { timeoutMs: 5000 })
    .then((description) => {
      if (
        !registration.approved() ||
        !connection.connected ||
        description.protocol !== RUNNER_WIRE_VERSION
      )
        return socket.destroy();
      const selfUpdate = parseSelfUpdateAdvert(
        description.capabilities.selfUpdate
      );
      peer = {
        connection,
        epoch,
        approved: registration.approved,
        description: {
          ...description,
          runnerId: runnerIdFromWire(registration.id),
          displayName: registration.name,
          capabilities: selfUpdate ? { selfUpdate } : {},
        },
        ...(selfUpdate && { selfUpdate }),
      };
      events.connected(peer);
      void health();
      void inventory();
      timer = setInterval(() => {
        void health();
        void inventory();
      }, 30_000);
      timer.unref();
    })
    .catch(() => socket.destroy());
  return connection;
}
