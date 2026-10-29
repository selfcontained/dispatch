import {
  parserOwnershipCases,
  runParserOwnershipScenario,
} from "./fixtures/request-parser-ownership.js";
import { describe, it } from "vitest";
import {
  runScenario,
  runUpgradeScenario,
  scenarios,
} from "./fixtures/request-lifecycle-fixture.js";

describe("real Fastify application settlement and recovery maintenance", () => {
  it(
    "preserves real websocket ownership and fenced admission",
    runUpgradeScenario
  );
  it.each(parserOwnershipCases)(
    "parser ownership after raw abort: %s",
    runParserOwnershipScenario,
    10_000
  );
  it.each(scenarios)(
    "%s",
    async (scenario) => {
      await runScenario(scenario);
    },
    10_000
  );
  it.each([
    "lost-success",
    "lost-error",
    "normal",
    "early-handler",
    "hijack-drain",
  ] as const)(
    "TLS additional listener: %s",
    async (scenario) => {
      await runScenario(scenario, "tls-additional");
    },
    10_000
  );
});
