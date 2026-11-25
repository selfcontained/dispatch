import { createHash } from "node:crypto";
import type {
  TaskGoal,
  TaskGoalChange,
  TaskGoalCounts,
  TaskGoalEdit,
  TaskGoalState,
} from "./types.js";

/** Goal rules shared by the service and its tools; SQL stays in the store. */
export const GOAL_TITLE_MAX_LENGTH = 200;
/** Goals one call may add or edit. */
export const GOAL_BATCH_MAX = 20;
/** Goals a task may hold, retired ones included. */
export const GOAL_TASK_MAX = 50;
export const GOAL_REQUEST_ID_MAX_LENGTH = 200;

export class GoalInputError extends Error {}

/** A trimmed, nonblank, single-line title of at most 200 characters. */
export function normalizeGoalTitle(raw: string): string {
  const title = raw.trim();
  if (!title) throw new GoalInputError("Goal titles cannot be blank.");
  if (/[\r\n]/.test(title))
    throw new GoalInputError("Goal titles must be a single line.");
  if (title.length > GOAL_TITLE_MAX_LENGTH)
    throw new GoalInputError(
      `Goal titles are at most ${GOAL_TITLE_MAX_LENGTH} characters.`
    );
  return title;
}

export function goalCounts(goals: TaskGoal[]): TaskGoalCounts {
  return {
    completed: goals.filter((goal) => goal.state === "completed").length,
    total: goals.filter((goal) => goal.state !== "retired").length,
  };
}

const key = (title: string) => title.toLowerCase();

/**
 * Titles to append, in order. A title matching a current (non-retired) goal
 * or an earlier title in the batch is skipped, so a retried add without a
 * requestId cannot duplicate a goal.
 */
export function planGoalAdds(current: TaskGoal[], rawTitles: string[]) {
  if (rawTitles.length === 0)
    throw new GoalInputError("Add at least one goal.");
  if (rawTitles.length > GOAL_BATCH_MAX)
    throw new GoalInputError(`Add at most ${GOAL_BATCH_MAX} goals at once.`);
  const seen = new Set(
    current.filter((goal) => goal.state !== "retired").map((g) => key(g.title))
  );
  const titles: string[] = [];
  for (const raw of rawTitles) {
    const title = normalizeGoalTitle(raw);
    if (seen.has(key(title))) continue;
    seen.add(key(title));
    titles.push(title);
  }
  if (current.length + titles.length > GOAL_TASK_MAX)
    throw new GoalInputError(
      `A task holds at most ${GOAL_TASK_MAX} goals, retired ones included.`
    );
  return titles;
}

const TRANSITIONS: Record<
  NonNullable<TaskGoalEdit["action"]>,
  { to: TaskGoalState; from: TaskGoalState[]; op: TaskGoalChange["op"] }
> = {
  complete: { to: "completed", from: ["open"], op: "completed" },
  reopen: { to: "open", from: ["completed", "retired"], op: "reopened" },
  retire: { to: "retired", from: ["open", "completed"], op: "retired" },
};

export type PlannedGoalEdit = {
  goalId: string;
  title?: string;
  state?: TaskGoalState;
};

/**
 * Validates a batch of edits against the task's goals and returns the
 * writes and the changes they record. An edit that matches the goal's
 * current title/state is a no-op, so a retried edit records nothing twice.
 * Any invalid edit rejects the whole batch.
 */
export function planGoalEdits(
  taskId: string,
  current: TaskGoal[],
  edits: TaskGoalEdit[]
): { writes: PlannedGoalEdit[]; changes: TaskGoalChange[] } {
  if (edits.length === 0) throw new GoalInputError("Send at least one edit.");
  if (edits.length > GOAL_BATCH_MAX)
    throw new GoalInputError(`Edit at most ${GOAL_BATCH_MAX} goals at once.`);
  const byId = new Map(current.map((goal) => [goal.id, { ...goal }]));
  const touched = new Set<string>();
  const writes: PlannedGoalEdit[] = [];
  const changes: TaskGoalChange[] = [];
  for (const edit of edits) {
    if (touched.has(edit.goalId))
      throw new GoalInputError(
        `Goal ${edit.goalId} appears more than once; send one edit per goal.`
      );
    touched.add(edit.goalId);
    const goal = byId.get(edit.goalId);
    if (!goal)
      throw new GoalInputError(
        `Goal ${edit.goalId} is not a goal of task ${taskId}.`
      );
    if (edit.title === undefined && edit.action === undefined)
      throw new GoalInputError(
        `Edit for goal ${edit.goalId} needs a title or an action.`
      );
    const write: PlannedGoalEdit = { goalId: goal.id };
    if (edit.title !== undefined) {
      const title = normalizeGoalTitle(edit.title);
      if (title !== goal.title) {
        changes.push({
          goalId: goal.id,
          op: "renamed",
          title,
          fromTitle: goal.title,
        });
        goal.title = title;
        write.title = title;
      }
    }
    if (edit.action !== undefined) {
      const transition = TRANSITIONS[edit.action];
      if (goal.state !== transition.to) {
        if (!transition.from.includes(goal.state))
          throw new GoalInputError(
            `Goal ${goal.id} is ${goal.state}; reopen it before you ${edit.action} it.`
          );
        changes.push({
          goalId: goal.id,
          op: transition.op,
          title: goal.title,
          fromState: goal.state,
        });
        goal.state = transition.to;
        write.state = transition.to;
      }
    }
    if (write.title !== undefined || write.state !== undefined)
      writes.push(write);
  }
  // Current titles stay distinct, so goals read unambiguously by name.
  const live = [...byId.values()].filter((goal) => goal.state !== "retired");
  const names = new Set<string>();
  for (const goal of live) {
    if (names.has(key(goal.title)))
      throw new GoalInputError(
        `Another current goal is already titled "${goal.title}".`
      );
    names.add(key(goal.title));
  }
  return { writes, changes };
}

/** Canonical request payloads: fixed field order, so equal requests hash equal. */
export function goalAddPayload(titles: string[]) {
  return { op: "add", titles: [...titles] };
}

export function goalEditPayload(edits: TaskGoalEdit[]) {
  return {
    op: "edit",
    edits: edits.map((edit) => [
      edit.goalId,
      edit.title ?? null,
      edit.action ?? null,
    ]),
  };
}

/** Days a requestId stays replayable. */
export const GOAL_REQUEST_RETENTION_DAYS = 7;

/** Identifies a request's payload so a reused requestId cannot change meaning. */
export function goalRequestFingerprint(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
