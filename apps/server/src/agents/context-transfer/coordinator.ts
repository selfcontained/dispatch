import { evaluateBudget } from "./budget.js";
import type { TransferLedger } from "./store.js";
import {
  RuntimeIdentitySchema,
  TransferConflict,
  TransferRequestSchema,
  type RuntimeIdentity,
  type TransferRecord,
  type TransferRequest,
} from "./types.js";

const sameIdentity = (a: RuntimeIdentity, b: RuntimeIdentity) =>
  JSON.stringify(RuntimeIdentitySchema.parse(a)) ===
  JSON.stringify(RuntimeIdentitySchema.parse(b));

/** Unwired, disabled-by-default foundation. Pickup never activates a writer. */
export class ContextTransferCoordinator {
  constructor(
    private readonly ledger: TransferLedger,
    private readonly options: { enabled?: boolean; now?: () => number } = {}
  ) {}

  private enabled(): void {
    if (this.options.enabled !== true)
      throw new Error("Context transfer preparation is disabled");
  }
  private async read(id: string): Promise<TransferRecord> {
    const row = await this.ledger.get(id);
    if (!row) throw new TransferConflict("Transfer not found");
    return row;
  }
  private async change(
    current: TransferRecord,
    next: Parameters<TransferLedger["compareAndSet"]>[1]
  ): Promise<TransferRecord> {
    const changed = await this.ledger.compareAndSet(current, next);
    if (changed) return changed;
    const row = await this.read(current.transferId);
    if (
      row.state === next.state &&
      (!next.successorAgentId ||
        row.successorAgentId === next.successorAgentId) &&
      (!next.failureReason || row.failureReason === next.failureReason)
    )
      return row;
    throw new TransferConflict(
      "Transfer changed concurrently; reconcile before retry"
    );
  }

  async prepare(
    input: TransferRequest,
    expected: { identity: RuntimeIdentity; boundary: number }
  ): Promise<TransferRecord> {
    this.enabled();
    const request = TransferRequestSchema.parse(input);
    if (!sameIdentity(request.handoff.identity, expected.identity)) {
      throw new TransferConflict(
        "Handoff identity does not match current worktree or permissions"
      );
    }
    if (request.budget.boundary !== expected.boundary) {
      throw new TransferConflict("Preparation boundary no longer current");
    }
    // A committed preparation may outlive its budget observation after a lost reply.
    // Reconcile its immutable request rather than create another intent.
    if (
      await this.ledger.findBoundary(
        request.budget.identity.agentId,
        request.budget.boundary
      )
    ) {
      return this.ledger.prepare(request);
    }
    const decision = evaluateBudget(
      request.budget,
      expected,
      (this.options.now ?? Date.now)()
    );
    if (decision.action !== "prepare") {
      throw new TransferConflict(
        `Transfer requires insufficient post-compaction budget (${decision.action})`
      );
    }
    return this.ledger.prepare(request);
  }

  /** Returns a stable reconciliation key, never calls a launcher. */
  async reserveLaunch(
    id: string,
    current: { identity: RuntimeIdentity; boundary: number }
  ): Promise<TransferRecord> {
    this.enabled();
    const row = await this.read(id);
    if (
      !sameIdentity(row.request.budget.identity, current.identity) ||
      row.request.budget.boundary !== current.boundary
    ) {
      throw new TransferConflict(
        "Worktree or permissions changed before launch reservation"
      );
    }
    if (
      ["launch_reserved", "receipt_recorded", "pickup_verified"].includes(
        row.state
      )
    )
      return row;
    if (row.state !== "prepared")
      throw new TransferConflict("Transfer is terminal");
    return this.change(row, { state: "launch_reserved" });
  }

  async recordLaunchReceipt(
    id: string,
    launchKey: string,
    successorAgentId: string
  ): Promise<TransferRecord> {
    this.enabled();
    const row = await this.read(id);
    if (
      launchKey !== row.launchKey ||
      !successorAgentId.trim() ||
      successorAgentId.length > 200 ||
      successorAgentId.trim() !== successorAgentId ||
      successorAgentId === row.request.budget.identity.agentId
    ) {
      throw new TransferConflict("Invalid launch receipt");
    }
    if (
      ["receipt_recorded", "pickup_verified"].includes(row.state) &&
      row.successorAgentId === successorAgentId
    )
      return row;
    if (row.state !== "launch_reserved")
      throw new TransferConflict(
        "Reconcile existing successor before recording another"
      );
    return this.change(row, { state: "receipt_recorded", successorAgentId });
  }

  async verifyPickup(
    id: string,
    pickup: {
      successorAgentId: string;
      handoffHash: string;
      handoffIdentity: RuntimeIdentity;
    }
  ): Promise<TransferRecord> {
    this.enabled();
    const row = await this.read(id);
    if (row.state !== "receipt_recorded" && row.state !== "pickup_verified") {
      throw new TransferConflict("Pickup requires a recorded launch receipt");
    }
    if (
      pickup.successorAgentId !== row.successorAgentId ||
      pickup.handoffHash !== row.request.handoff.sha256 ||
      !sameIdentity(pickup.handoffIdentity, row.request.handoff.identity)
    ) {
      return this.change(row, {
        state: "failed",
        failureReason: "pickup_mismatch",
      });
    }
    if (row.state === "pickup_verified") return row;
    return this.change(row, { state: "pickup_verified" });
  }

  async cancel(id: string): Promise<TransferRecord> {
    const row = await this.ledger.cancel(id);
    if (!row) throw new TransferConflict("Transfer not found");
    return row;
  }
}
