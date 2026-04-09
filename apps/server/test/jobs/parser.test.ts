import { describe, expect, it } from "vitest";

import { parseJobDefinition } from "../../src/jobs/parser.js";

describe("parseJobDefinition", () => {
  it("parses job frontmatter and markdown body", () => {
    const job = parseJobDefinition(`---
name: janitor
schedule: "0 * * * *"
timeout: 10s
needs_input_timeout: 2h
full_access: true
notify:
  on_complete:
    - slack
  on_error:
    - slack
    - email
  on_needs_input: []
---
# Clean up

Remove stale files.
`, { directory: "/tmp/repo", filePath: "/tmp/repo/.dispatch/jobs/janitor.md" });

    expect(job.name).toBe("janitor");
    expect(job.schedule).toBe("0 * * * *");
    expect(job.timeoutMs).toBe(10_000);
    expect(job.needsInputTimeoutMs).toBe(7_200_000);
    expect(job.fullAccess).toBe(true);
    expect(job.notify.onComplete).toEqual(["slack"]);
    expect(job.notify.onError).toEqual(["slack", "email"]);
    expect(job.body).toContain("Remove stale files.");
  });

  it("returns clear validation errors", () => {
    expect(() => parseJobDefinition(`---
name: bad
timeout: forever
---
Body
`, { directory: "/tmp/repo", filePath: "/tmp/repo/.dispatch/jobs/bad.md" })).toThrow("timeout must be a duration");
  });

  it("validates cron schedule shape", () => {
    expect(() => parseJobDefinition(`---
name: bad-schedule
schedule: "* * *"
---
Body
`, { directory: "/tmp/repo", filePath: "/tmp/repo/.dispatch/jobs/bad-schedule.md" })).toThrow("schedule must be a 5-field cron expression");
  });
});
