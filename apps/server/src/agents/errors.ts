export class AgentError extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.statusCode = statusCode;
  }
}

export class CheckoutStatusUnavailable extends AgentError {
  constructor() {
    super("Checkout status is unavailable on the owning runner.", 503);
  }
}

export class LifecycleSuperseded extends Error {}
