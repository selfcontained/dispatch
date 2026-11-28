import { expect, it } from "vitest";
import { launchListenerEnv } from "../src/agents/acp/launch-env.js";

it("gives dispatch-stream and API tools the selected origin without IPv4 loopback", () => {
  const env = launchListenerEnv(
    {
      port: 7000,
      tls: null,
      listenHosts: ["::1"],
    },
    {}
  );
  expect(env.DISPATCH_API_URL).toBe("http://[::1]:7000");
  expect(env.DISPATCH_API_BASE).toBe(env.DISPATCH_API_URL);
});
