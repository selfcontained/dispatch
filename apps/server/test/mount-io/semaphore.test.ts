import { describe, expect, it } from "vitest";

import { Semaphore } from "../../src/shared/mount-io/semaphore.js";

describe("Semaphore", () => {
  it("grants permits immediately while capacity remains", async () => {
    const sem = new Semaphore(2);
    await sem.acquire();
    await sem.acquire();
    expect(sem.available).toBe(0);
  });

  it("queues acquisitions beyond capacity until release", async () => {
    const sem = new Semaphore(1);
    await sem.acquire();

    let third = false;
    const pending = sem.acquire().then(() => {
      third = true;
    });

    await Promise.resolve();
    expect(third).toBe(false);

    sem.release();
    await pending;
    expect(third).toBe(true);
  });

  it("never lets more than max run at once", async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let peak = 0;

    const task = async () => {
      await sem.acquire();
      active++;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active--;
      sem.release();
    };

    await Promise.all(Array.from({ length: 10 }, task));
    expect(peak).toBeLessThanOrEqual(2);
  });
});
