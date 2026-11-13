// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { manifest } from "./slack-app-section";

describe("Slack app manifest", () => {
  it("asks for the bot scopes each Slack feature needs", () => {
    const scopes: string[] = JSON.parse(manifest).oauth_config.scopes.bot;
    // Reacting ✅ to a thread reply recorded as an answer.
    expect(scopes).toContain("reactions:write");
    expect(scopes).toContain("reactions:read");
    // Posting as the agent, thread replies and images.
    expect(scopes).toEqual(
      expect.arrayContaining([
        "chat:write",
        "chat:write.customize",
        "channels:history",
        "groups:history",
        "files:write",
        "files:read",
      ])
    );
    expect(new Set(scopes).size).toBe(scopes.length);
  });
});
