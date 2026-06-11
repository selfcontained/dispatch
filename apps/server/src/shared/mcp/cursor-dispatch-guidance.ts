const CURSOR_TOOL_EXPOSURE_NOTE =
  "Cursor note: Dispatch tools are exposed as callable functions in the commentary channel with names beginning `dispatch-`. Use those exact function tools";

export function buildCursorDispatchEventFirstActionRule(
  message: string,
  visibleToolNames: string[]
): string {
  return `MANDATORY FIRST ACTION: Before reading files, running git, or replying, call dispatch_event with type "working" and a short message. ${CURSOR_TOOL_EXPOSURE_NOTE}; for example, call \`functions.dispatch-dispatch_event({ type: "working", message: "${message}" })\`. ${buildCursorDispatchToolAvailabilityGuardrail(visibleToolNames)}`;
}

export function buildCursorDispatchToolAvailabilityGuardrail(
  visibleToolNames: string[]
): string {
  return `Do not say Dispatch tools are unavailable if you can see any callable function names such as ${visibleToolNames.map((toolName) => `\`${toolName}\``).join(", ")}. If a Dispatch tool call fails, report the exact tool error.`;
}
