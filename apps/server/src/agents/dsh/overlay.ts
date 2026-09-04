import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { stringify } from "yaml";

/** One `llm-pi-ai` provider route (see dsh's `@deepseek-ai/dsh-llm-pi-ai`). */
export type ProviderRoute = {
  apiKeyEnv?: string;
  baseURL?: string;
  api?: string;
  displayName?: string;
  models?: { id: string; contextWindow?: number }[];
};

export type OverlayInput = {
  /** `provider/model`, or null to keep the profile default. */
  model: string | null;
  /** Full persona text: launch guidance plus persona brief or personality. */
  persona: string;
  /** Extra provider routes; the OpenAI route is declared by default. */
  providers?: Record<string, ProviderRoute>;
};

const DEFAULT_PROVIDERS: Record<string, ProviderRoute> = {
  openai: { apiKeyEnv: "OPENAI_API_KEY" },
};

export function splitModelId(model: string): {
  provider: string;
  model: string;
} {
  const idx = model.indexOf("/");
  if (idx <= 0 || idx === model.length - 1) {
    throw new Error(`dsh model ids are provider/model; got "${model}"`);
  }
  return { provider: model.slice(0, idx), model: model.slice(idx + 1) };
}

/**
 * The per-agent `--patch` layer. Each entry replaces the config of the row
 * with that id in the composed acp profile: provider routes, the deployment
 * persona, and the default model for both new agents and ACP sessions.
 */
export function buildOverlayYaml(input: OverlayInput): string {
  const rows: { id: string; config: Record<string, unknown> }[] = [
    {
      id: "llm-pi-ai",
      config: { providers: input.providers ?? DEFAULT_PROVIDERS },
    },
    { id: "system-prompt", config: { persona: input.persona } },
  ];
  if (input.model) {
    const selected = splitModelId(input.model);
    rows.push({ id: "agent-default-model", config: selected });
    rows.push({ id: "acp", config: selected });
  }
  return stringify(rows);
}

/** Writes `<dir>/<agentId>.patch.yml` and returns its path. */
export async function writeOverlay(
  dir: string,
  agentId: string,
  input: OverlayInput
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${agentId}.patch.yml`);
  await writeFile(file, buildOverlayYaml(input), "utf8");
  return file;
}
