import type { EngineBins } from "../agents/acp/engine-spec.js";

export let startupAcpAdapter: EngineBins["adapter"];

// Called by the server entry point before dotenv and login-shell restoration.
// The server launcher disables Bun's automatic dotenv loading.
export function captureStartupAcpAdapter(): void {
  startupAcpAdapter = parseAdapter(process.env.DISPATCH_ACP_ADAPTER_COMMAND);
}

function parseAdapter(value: string | undefined): EngineBins["adapter"] {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      Array.isArray(parsed) &&
      typeof parsed[0] === "string" &&
      parsed[0].length > 0 &&
      parsed.every((part) => typeof part === "string")
    ) {
      const [bin, ...args] = parsed as [string, ...string[]];
      return { bin, args };
    }
  } catch {
    // A malformed override leaves the bundled adapter in use.
  }
  return undefined;
}
