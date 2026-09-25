import { describe, expect, it } from "vitest";
import { buildLaunchGuidance } from "../src/agents/launch-guidance.js";

describe("launch guidance", () => {
  it("always supplies the workflows that must also work without a plugin", () => {
    const guidance = buildLaunchGuidance("agt_example", {
      suggestSessionRename: true,
    });
    expect(guidance).toContain("No task, no work");
    expect(guidance).toContain("rename_session");
    expect(guidance).toContain("browser_close");
    expect(guidance).toContain("gh pr create");
    expect(guidance).toContain("list_personas then launch_agent");
    expect(guidance).toContain("question block");
  });

  it("keeps unattended jobs on their dedicated lifecycle", () => {
    const guidance = buildLaunchGuidance("agt_job", { jobRunId: "run-123" });
    expect(guidance).toContain("run-123");
    expect(guidance).toContain("job_log");
    expect(guidance).toContain("job_complete, job_failed, or job_needs_input");
    expect(guidance).not.toContain("No task, no work");
  });
});
