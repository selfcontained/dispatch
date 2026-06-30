import { describe, expect, it } from "vitest";

import { CircuitBreaker } from "../../src/shared/mount-io/circuit-breaker.js";

const clock = (start = 0) => {
  let t = start;
  const now = () => t;
  return { now, advance: (ms: number) => (t += ms) };
};

describe("CircuitBreaker", () => {
  it("stays closed below the failure threshold", () => {
    const b = new CircuitBreaker(3, 1000, () => 0);
    b.recordFailure();
    b.recordFailure();
    expect(b.state()).toBe("closed");
    expect(b.canProceed()).toBe(true);
  });

  it("opens at the failure threshold and blocks", () => {
    const b = new CircuitBreaker(3, 1000, () => 0);
    b.recordFailure();
    b.recordFailure();
    b.recordFailure();
    expect(b.state()).toBe("open");
    expect(b.canProceed()).toBe(false);
  });

  it("moves to half-open after the cooldown elapses", () => {
    const c = clock();
    const b = new CircuitBreaker(1, 1000, c.now);
    b.recordFailure();
    expect(b.state()).toBe("open");
    c.advance(1000);
    expect(b.state()).toBe("half-open");
    expect(b.canProceed()).toBe(true);
  });

  it("re-opens when the half-open probe fails", () => {
    const c = clock();
    const b = new CircuitBreaker(1, 1000, c.now);
    b.recordFailure();
    c.advance(1000);
    expect(b.state()).toBe("half-open");
    b.recordFailure();
    expect(b.state()).toBe("open");
  });

  it("closes when the half-open probe succeeds", () => {
    const c = clock();
    const b = new CircuitBreaker(1, 1000, c.now);
    b.recordFailure();
    c.advance(1000);
    b.recordSuccess();
    expect(b.state()).toBe("closed");
    expect(b.canProceed()).toBe(true);
  });

  it("resets failure count on success", () => {
    const b = new CircuitBreaker(3, 1000, () => 0);
    b.recordFailure();
    b.recordFailure();
    b.recordSuccess();
    b.recordFailure();
    b.recordFailure();
    expect(b.state()).toBe("closed");
  });
});
