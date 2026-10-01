import { expect, it } from "vitest";
import { buildLaunchEnv } from "../src/agents/acp/launch-env.js";

it("gives dispatch-stream and API tools the selected origin without IPv4 loopback", () => {
  const { env } = buildLaunchEnv({
    agentId: "agt_test",
    filesDir: "/tmp/test",
    engine: "codex",
    config: {
      port: 7000,
      tls: null,
      dispatchBinDir: "/tmp/bin",
      listenHosts: ["::1"],
    },
    base: {},
  });
  expect(env.DISPATCH_API_URL).toBe("http://[::1]:7000");
  expect(env.DISPATCH_API_BASE).toBe(env.DISPATCH_API_URL);
});
