export type JobTaskStatus = "success" | "skipped" | "error";
export type JobReportStatus = "completed" | "failed" | "running";

export type JobReportError = {
  message: string;
  recoverable?: boolean;
  action?: string;
};

export type JobReportLog = {
  message: string;
  level: "debug" | "info" | "warn" | "error";
  createdAt: string;
};

export type JobReportTask = {
  name: string;
  status: JobTaskStatus;
  summary: string;
  errors?: JobReportError[];
  logs?: JobReportLog[];
};

export type JobReport = {
  status: JobReportStatus;
  summary: string;
  tasks: JobReportTask[];
};

export function validateTerminalJobReport(value: unknown, expectedStatus: "completed" | "failed"): JobReport {
  const report = validateJobReport(value);
  if (report.status !== expectedStatus) {
    throw new Error(`report.status must be "${expectedStatus}".`);
  }
  return report;
}

const MAX_SUMMARY_LENGTH = 10_000;
const MAX_TASK_NAME_LENGTH = 200;
const MAX_ERROR_MESSAGE_LENGTH = 10_000;
const MAX_LOG_MESSAGE_LENGTH = 5_000;
const MAX_TASKS = 100;
const MAX_ERRORS_PER_TASK = 100;
const MAX_LOGS_PER_TASK = 500;
const MAX_REPORT_BYTES = 1_000_000; // 1 MB

export function validateJobReport(value: unknown): JobReport {
  if (!isRecord(value)) throw new Error("report must be an object.");
  const status = value.status;
  if (status !== "completed" && status !== "failed" && status !== "running") {
    throw new Error('report.status must be one of: "completed", "failed", "running".');
  }
  const summary = readNonEmptyString(value.summary, "report.summary");
  if (summary.length > MAX_SUMMARY_LENGTH) throw new Error(`report.summary exceeds ${MAX_SUMMARY_LENGTH} character limit.`);
  if (!Array.isArray(value.tasks)) throw new Error("report.tasks must be an array.");
  if (value.tasks.length > MAX_TASKS) throw new Error(`report.tasks exceeds ${MAX_TASKS} task limit.`);
  const tasks = value.tasks.map((task, index) => validateTask(task, index));
  const report: JobReport = { status, summary, tasks };
  const serialized = JSON.stringify(report);
  if (Buffer.byteLength(serialized, "utf-8") > MAX_REPORT_BYTES) {
    throw new Error(`Report exceeds ${MAX_REPORT_BYTES / 1_000_000}MB size limit.`);
  }
  return report;
}

export function appendJobLog(report: JobReport | null, input: {
  task: string;
  message: string;
  level: "debug" | "info" | "warn" | "error";
}): JobReport {
  const taskName = input.task.trim();
  const message = input.message.trim();
  if (!taskName) throw new Error("task must be a non-empty string.");
  if (!message) throw new Error("message must be a non-empty string.");

  const next: JobReport = report
    ? {
        status: report.status,
        summary: report.summary,
        tasks: report.tasks.map((task) => ({ ...task, errors: task.errors ? [...task.errors] : undefined, logs: task.logs ? [...task.logs] : undefined }))
      }
    : { status: "running", summary: "Job is running.", tasks: [] };

  let task = next.tasks.find((candidate) => candidate.name === taskName);
  if (!task) {
    if (next.tasks.length >= MAX_TASKS) {
      throw new Error(`Cannot add task "${taskName}": report already has ${MAX_TASKS} tasks.`);
    }
    task = { name: taskName, status: "success", summary: "", logs: [] };
    next.tasks.push(task);
  }

  const logs = [
    ...(task.logs ?? []),
    {
      message: message.slice(0, MAX_LOG_MESSAGE_LENGTH),
      level: input.level,
      createdAt: new Date().toISOString()
    }
  ];
  // Keep only the most recent entries if we exceed the cap
  task.logs = logs.length > MAX_LOGS_PER_TASK ? logs.slice(-MAX_LOGS_PER_TASK) : logs;
  return next;
}

function validateTask(value: unknown, index: number): JobReportTask {
  if (!isRecord(value)) throw new Error(`report.tasks[${index}] must be an object.`);
  const status = value.status;
  if (status !== "success" && status !== "skipped" && status !== "error") {
    throw new Error(`report.tasks[${index}].status must be one of: "success", "skipped", "error".`);
  }
  const name = readNonEmptyString(value.name, `report.tasks[${index}].name`);
  if (name.length > MAX_TASK_NAME_LENGTH) throw new Error(`report.tasks[${index}].name exceeds ${MAX_TASK_NAME_LENGTH} character limit.`);
  const summary = typeof value.summary === "string" ? value.summary.slice(0, MAX_SUMMARY_LENGTH) : "";
  const task: JobReportTask = { name, status, summary };
  if (value.errors !== undefined) {
    if (!Array.isArray(value.errors)) throw new Error(`report.tasks[${index}].errors must be an array.`);
    if (value.errors.length > MAX_ERRORS_PER_TASK) throw new Error(`report.tasks[${index}].errors exceeds ${MAX_ERRORS_PER_TASK} error limit.`);
    task.errors = value.errors.map((error, errorIndex) => validateTaskError(error, index, errorIndex));
  }
  if (value.logs !== undefined) {
    if (!Array.isArray(value.logs)) throw new Error(`report.tasks[${index}].logs must be an array.`);
    if (value.logs.length > MAX_LOGS_PER_TASK) throw new Error(`report.tasks[${index}].logs exceeds ${MAX_LOGS_PER_TASK} log limit.`);
    task.logs = value.logs.map((log, logIndex) => validateTaskLog(log, index, logIndex));
  }
  return task;
}

function validateTaskError(value: unknown, taskIndex: number, errorIndex: number): JobReportError {
  if (!isRecord(value)) throw new Error(`report.tasks[${taskIndex}].errors[${errorIndex}] must be an object.`);
  const message = readNonEmptyString(value.message, `report.tasks[${taskIndex}].errors[${errorIndex}].message`);
  const error: JobReportError = {
    message: message.slice(0, MAX_ERROR_MESSAGE_LENGTH)
  };
  if (typeof value.recoverable === "boolean") error.recoverable = value.recoverable;
  if (typeof value.action === "string") error.action = value.action.slice(0, MAX_ERROR_MESSAGE_LENGTH);
  return error;
}

function validateTaskLog(value: unknown, taskIndex: number, logIndex: number): JobReportLog {
  if (!isRecord(value)) throw new Error(`report.tasks[${taskIndex}].logs[${logIndex}] must be an object.`);
  const level = value.level;
  if (level !== "debug" && level !== "info" && level !== "warn" && level !== "error") {
    throw new Error(`report.tasks[${taskIndex}].logs[${logIndex}].level must be one of: "debug", "info", "warn", "error".`);
  }
  return {
    message: readNonEmptyString(value.message, `report.tasks[${taskIndex}].logs[${logIndex}].message`),
    level,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString()
  };
}

function readNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
