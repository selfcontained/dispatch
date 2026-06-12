export function buildCursorDispatchToolGuidance(): string {
  return 'Cursor note: Dispatch tools are exposed as callable functions with the naming convention `dispatch-<tool_name>`, called via `functions.dispatch-<tool_name>({...})`. For example, `functions.dispatch-dispatch_event({ type: "working", message: "Starting" })`. Do not say Dispatch tools are unavailable if you can see callable function names beginning with `dispatch-`. If a Dispatch tool call fails, report the exact tool error.';
}
