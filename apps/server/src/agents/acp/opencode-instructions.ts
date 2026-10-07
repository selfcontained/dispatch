import { writeFile } from "node:fs/promises";
import path from "node:path";
import { parse, type ParseError } from "jsonc-parser";

/** Add per-agent guidance to OpenCode's native system instructions. */
export async function openCodeInstructionsEnv(
  stateDir: string,
  instructions: string | null,
  env: NodeJS.ProcessEnv
): Promise<NodeJS.ProcessEnv> {
  if (!instructions) return env;
  const errors: ParseError[] = [];
  const config: unknown = env.OPENCODE_CONFIG_CONTENT
    ? parse(env.OPENCODE_CONFIG_CONTENT, errors, { allowTrailingComma: true })
    : {};
  if (
    errors.length ||
    !config ||
    typeof config !== "object" ||
    Array.isArray(config)
  ) {
    throw new Error(
      "OPENCODE_CONFIG_CONTENT must contain an OpenCode configuration object."
    );
  }
  const current = config as Record<string, unknown>;
  if (
    current.instructions !== undefined &&
    (!Array.isArray(current.instructions) ||
      current.instructions.some((value) => typeof value !== "string"))
  ) {
    throw new Error(
      "OPENCODE_CONFIG_CONTENT instructions must be an array of paths."
    );
  }
  const file = path.join(stateDir, "dispatch-instructions.md");
  await writeFile(file, instructions, { mode: 0o600 });
  return {
    ...env,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      ...current,
      instructions: [
        ...new Set([
          ...((current.instructions as string[] | undefined) ?? []),
          file,
        ]),
      ],
    }),
  };
}
