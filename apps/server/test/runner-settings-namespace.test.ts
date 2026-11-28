import { describe, expect, it } from "vitest";
import {
  localRunnerSettings,
  enrolledRunnerSettings,
  namespaced,
} from "../src/runners/settings-namespace.js";

const keys = [
  "agent_models:codex",
  "agent_model_availability:codex",
  "engine_update_operations",
];
describe("runner settings namespaces", () => {
  it.each(keys)("retains main's local key %s", (key) => {
    expect(namespaced(localRunnerSettings, key)).toBe(key);
  });
  it.each(keys)("isolates runner identities for %s", (key) => {
    expect(namespaced(enrolledRunnerSettings("a"), key)).toBe(
      `runner:a:${key}`
    );
    expect(namespaced(enrolledRunnerSettings("b"), key)).toBe(
      `runner:b:${key}`
    );
    const odd = namespaced(
      enrolledRunnerSettings("local:agent_models:codex"),
      key
    );
    expect(odd).toBe(`runner:local%3Aagent_models%3Acodex:${key}`);
    expect(odd).not.toBe(
      namespaced(enrolledRunnerSettings("local%3Aagent_models%3Acodex"), key)
    );
    expect(keys).not.toContain(odd);
    expect(odd).not.toBe(namespaced(enrolledRunnerSettings("a"), key));
  });
});
