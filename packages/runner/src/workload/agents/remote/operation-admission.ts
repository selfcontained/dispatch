import { checkoutCommandTimeoutMs } from "@dispatch/runner-protocol";
import { operations, type OpName } from "@dispatch/runner-protocol/contract";
import {
  UPDATE_FENCED_MESSAGE,
  type UpdateAdmission,
} from "./update-admission.js";

const exempt = new Set<OpName>([
  "runner.describe",
  "runner.health",
  "session.attach",
  "session.alive",
  "session.logs",
  "session.list",
  "session.sample",
  "engine.list",
  "engine.operation",
  "engine.login.status",
  "engine.update.inspect",
  "engine.update.probe",
  "update.offer",
  "update.fence",
  "update.activate",
  "update.confirm",
  "update.cancel",
]);

/** Same drain budget as the workload operation this replaces. */
function deadline(op: OpName, input: unknown) {
  if (op === "checkout.exec" && operations[op].request.check(input)) {
    const select =
      "session" in input.target ? input.target.checkout : undefined;
    const requested =
      input.timeoutMs ??
      checkoutCommandTimeoutMs(
        select === "launch" || select === "moved" ? select : "effective"
      );
    return 5000 + Math.min(requested, 2147470000);
  }
  if (
    op.startsWith("engine.") ||
    op.startsWith("files.") ||
    op.startsWith("workspace.") ||
    op === "git.context" ||
    (op.startsWith("checkout.") &&
      op !== "checkout.write" &&
      op !== "checkout.watch")
  )
    return 300000;
  return 20000;
}

export function enrolledAdmission(admission: Pick<UpdateAdmission, "admit">) {
  return {
    message: UPDATE_FENCED_MESSAGE,
    enter(op: string, input?: unknown) {
      if (
        op === "engine.list" &&
        operations[op].request.check(input) &&
        input.background
      )
        return admission.admit(60_000)?.release ?? null;
      if (!Object.hasOwn(operations, op) || exempt.has(op as OpName))
        return () => {};
      return admission.admit(deadline(op as OpName, input))?.release ?? null;
    },
  };
}
