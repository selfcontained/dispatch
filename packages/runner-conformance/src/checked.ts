/*
 * Every response, event and failure a scenario sees is checked against the
 * contract: responses and events against the operation's schemas, failures
 * against the error shape and the codes the operation may return.
 */
import {
  COMMON_ERRORS,
  RunnerCallError,
  operations,
  runnerDescription,
  type CallName,
  type CallOptions,
  type ErrorCode,
  type OpName,
  type OpenName,
  type Req,
  type Res,
  type Runner,
} from "@dispatch/runner-protocol/contract";

export class ContractViolation extends Error {
  override name = "ContractViolation";
}

function allowedCodes(op: OpName): Set<ErrorCode> {
  return new Set<ErrorCode>([...COMMON_ERRORS, ...operations[op].errors]);
}

/** A rejection as a contract error; throws a violation if it is not one. */
export function contractError(op: OpName, error: unknown): RunnerCallError {
  if (error instanceof ContractViolation) throw error;
  if (!(error instanceof RunnerCallError))
    throw new ContractViolation(
      `${op} failed with a non-contract error: ${String((error as Error)?.message ?? error)}`
    );
  // `unsupported` is how a runner without the operation answers.
  if (!allowedCodes(op).has(error.code) && error.code !== "unsupported")
    throw new ContractViolation(
      `${op} failed with undeclared code ${error.code}: ${error.message}`
    );
  return error;
}

function checkEvent(op: OpName, event: unknown) {
  const schema = (operations[op] as { events?: { check(v: unknown): boolean } })
    .events;
  if (!schema?.check(event))
    throw new ContractViolation(`${op} emitted an event outside its schema.`);
}

/** The same runner, with every reply checked against the contract. */
export function checked(runner: Runner): Runner {
  const rethrow = (op: OpName, error: unknown): never => {
    throw contractError(op, error);
  };
  return {
    describe() {
      const description = runner.describe();
      if (!runnerDescription.check(description))
        throw new ContractViolation("describe() is outside the contract.");
      return description;
    },
    connection: runner.connection,
    async call<K extends CallName>(
      op: K,
      req: Req<K>,
      opts?: CallOptions<K>
    ): Promise<Res<K>> {
      const events: unknown[] = [];
      let response: Res<K>;
      try {
        response = await runner.call(op, req, {
          ...opts,
          onEvent: (event) => {
            events.push(event);
            opts?.onEvent?.(event);
          },
        });
      } catch (error) {
        return rethrow(op, error);
      }
      for (const event of events) checkEvent(op, event);
      if (!operations[op].response.check(response))
        throw new ContractViolation(
          `${op} returned a response outside its schema: ${JSON.stringify(response)}`
        );
      return response;
    },
    async open<K extends OpenName>(op: K, req: Req<K>, opts?: CallOptions<K>) {
      try {
        const opened = await runner.open(op, req, opts);
        if (!operations[op].response.check(opened.info))
          throw new ContractViolation(
            `${op} returned info outside its schema.`
          );
        return opened;
      } catch (error) {
        return rethrow(op, error);
      }
    },
  };
}
