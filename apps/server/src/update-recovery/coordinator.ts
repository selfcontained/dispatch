import type { RecoveryManifest, RecoveryTransaction } from "./store.js";
import { RecoveryStore } from "./store.js";

/** All effects run under an external instance-wide OS lease. Implementations
 * must survive retries after power loss; transaction IDs identify their work.
 * No dependency may release the normal-write fence during a trial. */
export interface RecoveryEffects {
  stopAndFence(transaction: RecoveryTransaction): Promise<void>;
  checkpoint(transaction: RecoveryTransaction): Promise<RecoveryManifest>;
  activate(transaction: RecoveryTransaction): Promise<void>;
  startTrial(transaction: RecoveryTransaction): Promise<void>;
  proveReady(transaction: RecoveryTransaction): Promise<void>;
  /** Preserve failed data, restore into a new owned DB, restore runtime/state.
   * Must be idempotent, keeping the first failed-data copy on subsequent retries. */
  restore(
    transaction: RecoveryTransaction,
    manifest: RecoveryManifest
  ): Promise<void>;
  startRestoredTrial(transaction: RecoveryTransaction): Promise<void>;
  proveRestoredReady(transaction: RecoveryTransaction): Promise<void>;
  startNormal(transaction: RecoveryTransaction): Promise<void>;
}

/** Independent helper orchestration. A restarted helper never guesses that an
 * uncommitted target is healthy: it recovers before permitting normal startup. */
export class RecoveryCoordinator {
  constructor(
    private readonly store: RecoveryStore,
    private readonly effects: RecoveryEffects
  ) {}

  async apply(id: string): Promise<RecoveryTransaction> {
    let transaction = await this.store.read(id);
    if (transaction.phase !== "preparing") return this.resume(id);
    try {
      await this.effects.stopAndFence(transaction);
      await this.effects.checkpoint(transaction);
      transaction = await this.store.read(id);
      if (transaction.phase !== "backed-up")
        throw new Error("Checkpoint was not sealed");
      transaction = await this.store.transition(id, "backed-up", "activating");
      await this.effects.activate(transaction);
      transaction = await this.store.transition(id, "activating", "probation");
      await this.effects.startTrial(transaction);
      await this.effects.proveReady(transaction);
      // Commit is the durable boundary. Never rewind data after this point,
      // including when the normal restart itself fails.
      transaction = await this.store.transition(id, "probation", "committed");
    } catch {
      return this.resume(id);
    }
    await this.effects.startNormal(transaction);
    return transaction;
  }

  async resume(id: string): Promise<RecoveryTransaction> {
    let transaction = await this.store.read(id);
    if (["committed", "rolled-back", "aborted"].includes(transaction.phase)) {
      await this.effects.startNormal(transaction);
      return transaction;
    }
    // No executable was activated before this boundary. Keep incomplete
    // evidence, retain the old database, and restart the previous runtime.
    if (
      transaction.phase === "preparing" ||
      transaction.phase === "backed-up"
    ) {
      transaction = await this.store.transition(
        id,
        transaction.phase,
        "aborted",
        "CHECKPOINT_INTERRUPTED"
      );
      await this.effects.startNormal(transaction);
      return transaction;
    }
    try {
      // Stop first, even when snapshot verification fails. A damaged recovery
      // point must never allow an uncommitted migrated DB to resume writing.
      await this.effects.stopAndFence(transaction);
      const manifest = await this.store.verify(id);
      if (transaction.phase !== "restoring") {
        transaction = await this.store.transition(
          id,
          transaction.phase,
          "restoring",
          "TRIAL_FAILED"
        );
      }
      await this.effects.restore(transaction, manifest);
      await this.effects.startRestoredTrial(transaction);
      await this.effects.proveRestoredReady(transaction);
      transaction = await this.store.transition(id, "restoring", "rolled-back");
    } catch {
      transaction = await this.store.read(id);
      if (transaction.phase !== "recovery-required") {
        await this.store.transition(
          id,
          transaction.phase,
          "recovery-required",
          "RESTORE_FAILED"
        );
      }
      throw new Error(
        "Update recovery requires inspection; Dispatch remains fenced"
      );
    }
    await this.effects.startNormal(transaction);
    return transaction;
  }
}
