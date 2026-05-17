import { describe, it, expect } from "vitest";

import { dispatchMcpUrl } from "../src/agents/tmux/mcp-url.js";
import type { AppConfig } from "../src/config.js";

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    host: "127.0.0.1",
    port: 6767,
    databaseUrl: "",
    authToken: "",
    mediaRoot: "",
    dispatchBinDir: "",
    codexBin: "",
    claudeBin: "",
    opencodeBin: "",
    cursorBin: "",
    agentRuntime: "tmux",
    sessionPrefix: "dispatch",
    tls: null,
    ...overrides,
  };
}

describe("dispatchMcpUrl", () => {
  it("builds an HTTP URL for a standard agent", () => {
    const config = makeConfig({ port: 6767, tls: null });
    expect(dispatchMcpUrl(config, "agt_abc123")).toBe(
      "http://127.0.0.1:6767/api/mcp/agt_abc123"
    );
  });

  it("builds an HTTPS URL when TLS is configured", () => {
    const config = makeConfig({
      port: 8443,
      tls: { cert: Buffer.from("c"), key: Buffer.from("k") },
    });
    expect(dispatchMcpUrl(config, "agt_xyz")).toBe(
      "https://127.0.0.1:8443/api/mcp/agt_xyz"
    );
  });

  it("builds a job-scoped URL when jobRunId is provided", () => {
    const config = makeConfig({ port: 9000, tls: null });
    expect(dispatchMcpUrl(config, "agt_001", "run_42")).toBe(
      "http://127.0.0.1:9000/api/mcp/jobs/run_42/agt_001"
    );
  });

  it("uses the standard path when jobRunId is undefined", () => {
    const config = makeConfig();
    expect(dispatchMcpUrl(config, "agt_test", undefined)).toBe(
      "http://127.0.0.1:6767/api/mcp/agt_test"
    );
  });
});
