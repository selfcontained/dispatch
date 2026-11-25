import { expect, it } from "vitest";
import { LOGIN_ENGINES, isLoginEngine } from "@dispatch/shared";
import {
  LOGIN_ENGINES as wireEngines,
  isLoginEngine as wirePredicate,
} from "@dispatch/runner-protocol/engine-sign-in";
it("keeps controller and workload sign-in vocabulary on identical runtime instances", () => {
  expect(LOGIN_ENGINES).toBe(wireEngines);
  expect(isLoginEngine).toBe(wirePredicate);
});
