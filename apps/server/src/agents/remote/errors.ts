export class RunnerUnavailable extends Error {}
export class RunnerHostGone extends Error {}
/** The protected update fence refused the request before execution. */
export class RunnerUpdateFenced extends Error {}
/** The peer disconnected before acknowledging a dispatched mutation. */
export class RunnerAcknowledgementLost extends RunnerUnavailable {}
