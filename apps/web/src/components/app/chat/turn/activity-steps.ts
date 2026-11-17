import type { Step } from "./contracts";

/** Work shown by the activity line, including commands nested under tools. */
export function activitySteps(steps: Step[]): Step[] {
  return steps.flatMap((step) => [step, ...activitySteps(step.children ?? [])]);
}
