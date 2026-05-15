import { describe, expect, it } from "vitest";

import {
  validateJobReport,
  validateTerminalJobReport,
  appendJobLog,
} from "../../src/jobs/report.js";

function validReport(overrides: Record<string, unknown> = {}) {
  return {
    status: "completed",
    summary: "All tasks succeeded.",
    tasks: [{ name: "build", status: "success", summary: "Built OK." }],
    ...overrides,
  };
}

describe("validateJobReport", () => {
  it("accepts a minimal valid report", () => {
    const result = validateJobReport(validReport());
    expect(result.status).toBe("completed");
    expect(result.summary).toBe("All tasks succeeded.");
    expect(result.tasks).toHaveLength(1);
  });

  it("accepts all three status values", () => {
    for (const status of ["completed", "failed", "running"]) {
      const result = validateJobReport(validReport({ status }));
      expect(result.status).toBe(status);
    }
  });

  it("rejects non-object input", () => {
    expect(() => validateJobReport(null)).toThrow("report must be an object");
    expect(() => validateJobReport("string")).toThrow(
      "report must be an object"
    );
    expect(() => validateJobReport([])).toThrow("report must be an object");
  });

  it("rejects invalid status", () => {
    expect(() => validateJobReport(validReport({ status: "pending" }))).toThrow(
      "report.status"
    );
  });

  it("rejects empty or missing summary", () => {
    expect(() => validateJobReport(validReport({ summary: "" }))).toThrow(
      "report.summary"
    );
    expect(() => validateJobReport(validReport({ summary: 42 }))).toThrow(
      "report.summary"
    );
  });

  it("rejects summary exceeding 10,000 characters", () => {
    const longSummary = "x".repeat(10_001);
    expect(() =>
      validateJobReport(validReport({ summary: longSummary }))
    ).toThrow("10000 character limit");
  });

  it("rejects non-array tasks", () => {
    expect(() =>
      validateJobReport(validReport({ tasks: "not-array" }))
    ).toThrow("report.tasks must be an array");
  });

  it("rejects more than 100 tasks", () => {
    const tasks = Array.from({ length: 101 }, (_, i) => ({
      name: `task-${i}`,
      status: "success",
      summary: "ok",
    }));
    expect(() => validateJobReport(validReport({ tasks }))).toThrow(
      "100 task limit"
    );
  });

  it("accepts exactly 100 tasks", () => {
    const tasks = Array.from({ length: 100 }, (_, i) => ({
      name: `task-${i}`,
      status: "success",
      summary: "ok",
    }));
    const result = validateJobReport(validReport({ tasks }));
    expect(result.tasks).toHaveLength(100);
  });

  it("validates task status values", () => {
    for (const status of ["success", "skipped", "error"]) {
      const result = validateJobReport(
        validReport({
          tasks: [{ name: "t", status, summary: "ok" }],
        })
      );
      expect(result.tasks[0].status).toBe(status);
    }
    expect(() =>
      validateJobReport(
        validReport({
          tasks: [{ name: "t", status: "invalid", summary: "ok" }],
        })
      )
    ).toThrow("report.tasks[0].status");
  });

  it("rejects task with empty name", () => {
    expect(() =>
      validateJobReport(
        validReport({
          tasks: [{ name: "", status: "success", summary: "ok" }],
        })
      )
    ).toThrow("report.tasks[0].name");
  });

  it("rejects task name exceeding 200 characters", () => {
    expect(() =>
      validateJobReport(
        validReport({
          tasks: [{ name: "x".repeat(201), status: "success", summary: "ok" }],
        })
      )
    ).toThrow("200 character limit");
  });

  it("defaults missing task summary to empty string", () => {
    const result = validateJobReport(
      validReport({
        tasks: [{ name: "t", status: "success" }],
      })
    );
    expect(result.tasks[0].summary).toBe("");
  });

  it("validates task errors", () => {
    const result = validateJobReport(
      validReport({
        tasks: [
          {
            name: "t",
            status: "error",
            summary: "failed",
            errors: [
              {
                message: "Something broke",
                recoverable: true,
                action: "Retry",
              },
            ],
          },
        ],
      })
    );
    expect(result.tasks[0].errors).toHaveLength(1);
    expect(result.tasks[0].errors![0].message).toBe("Something broke");
    expect(result.tasks[0].errors![0].recoverable).toBe(true);
    expect(result.tasks[0].errors![0].action).toBe("Retry");
  });

  it("rejects non-array task errors", () => {
    expect(() =>
      validateJobReport(
        validReport({
          tasks: [
            { name: "t", status: "error", summary: "f", errors: "string" },
          ],
        })
      )
    ).toThrow("errors must be an array");
  });

  it("rejects more than 100 errors per task", () => {
    const errors = Array.from({ length: 101 }, () => ({ message: "err" }));
    expect(() =>
      validateJobReport(
        validReport({
          tasks: [{ name: "t", status: "error", summary: "f", errors }],
        })
      )
    ).toThrow("100 error limit");
  });

  it("rejects error with empty message", () => {
    expect(() =>
      validateJobReport(
        validReport({
          tasks: [
            {
              name: "t",
              status: "error",
              summary: "f",
              errors: [{ message: "" }],
            },
          ],
        })
      )
    ).toThrow("errors[0].message");
  });

  it("validates task logs", () => {
    const result = validateJobReport(
      validReport({
        tasks: [
          {
            name: "t",
            status: "success",
            summary: "ok",
            logs: [
              {
                message: "Step completed",
                level: "info",
                createdAt: "2026-01-01T00:00:00Z",
              },
            ],
          },
        ],
      })
    );
    expect(result.tasks[0].logs).toHaveLength(1);
    expect(result.tasks[0].logs![0].level).toBe("info");
  });

  it("rejects invalid log level", () => {
    expect(() =>
      validateJobReport(
        validReport({
          tasks: [
            {
              name: "t",
              status: "success",
              summary: "ok",
              logs: [{ message: "x", level: "critical" }],
            },
          ],
        })
      )
    ).toThrow("logs[0].level");
  });

  it("rejects more than 500 logs per task", () => {
    const logs = Array.from({ length: 501 }, () => ({
      message: "log",
      level: "info",
    }));
    expect(() =>
      validateJobReport(
        validReport({
          tasks: [{ name: "t", status: "success", summary: "ok", logs }],
        })
      )
    ).toThrow("500 log limit");
  });

  it("rejects reports exceeding 1MB when serialized", () => {
    const bigSummary = "x".repeat(9999);
    const tasks = Array.from({ length: 100 }, (_, i) => ({
      name: `task-${i}`,
      status: "success" as const,
      summary: bigSummary,
    }));
    expect(() =>
      validateJobReport({ status: "completed", summary: "s", tasks })
    ).toThrow("1MB size limit");
  });

  it("trims whitespace from summary", () => {
    const result = validateJobReport(validReport({ summary: "  hello  " }));
    expect(result.summary).toBe("hello");
  });
});

describe("validateTerminalJobReport", () => {
  it("accepts report matching expected status", () => {
    const result = validateTerminalJobReport(validReport(), "completed");
    expect(result.status).toBe("completed");
  });

  it("rejects report with mismatched status", () => {
    expect(() =>
      validateTerminalJobReport(validReport({ status: "failed" }), "completed")
    ).toThrow('report.status must be "completed"');
  });

  it("validates the underlying report structure", () => {
    expect(() => validateTerminalJobReport(null, "completed")).toThrow(
      "report must be an object"
    );
  });
});

describe("appendJobLog", () => {
  it("creates a new report when starting from null", () => {
    const result = appendJobLog(null, {
      task: "build",
      message: "Starting build",
      level: "info",
    });
    expect(result.status).toBe("running");
    expect(result.summary).toBe("Job is running.");
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].name).toBe("build");
    expect(result.tasks[0].logs).toHaveLength(1);
    expect(result.tasks[0].logs![0].message).toBe("Starting build");
  });

  it("appends to an existing task", () => {
    const initial = appendJobLog(null, {
      task: "build",
      message: "Step 1",
      level: "info",
    });
    const result = appendJobLog(initial, {
      task: "build",
      message: "Step 2",
      level: "info",
    });
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].logs).toHaveLength(2);
    expect(result.tasks[0].logs![1].message).toBe("Step 2");
  });

  it("creates a new task when the name is different", () => {
    const initial = appendJobLog(null, {
      task: "build",
      message: "Done",
      level: "info",
    });
    const result = appendJobLog(initial, {
      task: "test",
      message: "Running tests",
      level: "info",
    });
    expect(result.tasks).toHaveLength(2);
    expect(result.tasks[1].name).toBe("test");
  });

  it("rejects empty task name", () => {
    expect(() =>
      appendJobLog(null, { task: "", message: "hello", level: "info" })
    ).toThrow("task must be a non-empty string");
  });

  it("rejects empty message", () => {
    expect(() =>
      appendJobLog(null, { task: "build", message: "  ", level: "info" })
    ).toThrow("message must be a non-empty string");
  });

  it("truncates messages exceeding 5,000 characters", () => {
    const longMsg = "x".repeat(6000);
    const result = appendJobLog(null, {
      task: "build",
      message: longMsg,
      level: "info",
    });
    expect(result.tasks[0].logs![0].message.length).toBe(5000);
  });

  it("keeps only the most recent 500 logs per task", () => {
    let report = appendJobLog(null, {
      task: "build",
      message: "first",
      level: "info",
    });
    for (let i = 1; i <= 500; i++) {
      report = appendJobLog(report, {
        task: "build",
        message: `log-${i}`,
        level: "info",
      });
    }
    expect(report.tasks[0].logs!.length).toBe(500);
    expect(report.tasks[0].logs![0].message).toBe("log-1");
    expect(report.tasks[0].logs![499].message).toBe("log-500");
  });

  it("throws when adding a new task beyond the 100 task limit", () => {
    let report = appendJobLog(null, {
      task: "task-0",
      message: "init",
      level: "info",
    });
    for (let i = 1; i < 100; i++) {
      report = appendJobLog(report, {
        task: `task-${i}`,
        message: "init",
        level: "info",
      });
    }
    expect(report.tasks).toHaveLength(100);
    expect(() =>
      appendJobLog(report, {
        task: "task-100",
        message: "overflow",
        level: "info",
      })
    ).toThrow("100 tasks");
  });

  it("does not mutate the original report", () => {
    const original = appendJobLog(null, {
      task: "build",
      message: "step 1",
      level: "info",
    });
    const originalTasks = original.tasks.length;
    appendJobLog(original, {
      task: "test",
      message: "step 2",
      level: "info",
    });
    expect(original.tasks.length).toBe(originalTasks);
  });

  it("preserves existing report status and summary", () => {
    const initial = {
      status: "failed" as const,
      summary: "Something went wrong.",
      tasks: [
        { name: "build", status: "error" as const, summary: "Build failed" },
      ],
    };
    const result = appendJobLog(initial, {
      task: "build",
      message: "Adding detail",
      level: "error",
    });
    expect(result.status).toBe("failed");
    expect(result.summary).toBe("Something went wrong.");
  });

  it("sets createdAt on each log entry", () => {
    const result = appendJobLog(null, {
      task: "build",
      message: "hello",
      level: "info",
    });
    expect(result.tasks[0].logs![0].createdAt).toBeTruthy();
    expect(() => new Date(result.tasks[0].logs![0].createdAt)).not.toThrow();
  });
});
