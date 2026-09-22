export type SlashCommand = {
  name: string;
  description?: string;
  inputHint?: string;
  source: "agent" | "dispatch";
};

/** ACP recognizes a command only at the start of a prompt. */
export function slashQueryAt(text: string, caret: number): string | null {
  if (caret < 1 || caret > text.length || text[0] !== "/") return null;
  if (
    /\s/.test(text.slice(0, caret)) ||
    (text[caret] && !/\s/.test(text[caret]))
  ) {
    return null;
  }
  return text.slice(1, caret);
}

export function matchSlashCommands(
  query: string,
  commands: readonly SlashCommand[]
): SlashCommand[] {
  const lower = query.toLowerCase();
  return commands
    .filter((command) => command.name.toLowerCase().includes(lower))
    .slice(0, 8);
}
