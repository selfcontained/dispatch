const TEXT_EXTENSION_LIST = [
  ".txt",
  ".md",
  ".json",
  ".yaml",
  ".yml",
  ".log",
  ".csv",
  ".xml",
  ".html",
  ".css",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".sh",
  ".bash",
  ".zsh",
  ".sql",
  ".diff",
  ".patch",
  ".env",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".swift",
  ".kt",
  ".java",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".rb",
  ".php",
  ".lua",
  ".zig",
  ".nim",
  ".r",
  ".m",
  ".ex",
  ".exs",
  ".erl",
  ".hs",
];

export const TEXT_EXTENSIONS: ReadonlySet<string> = new Set(
  TEXT_EXTENSION_LIST
);

/** Lower-cased extension including the leading dot, or "" when there is none. */
export function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot).toLowerCase();
}

export function isTextFile(name: string): boolean {
  const ext = fileExtension(name);
  return ext !== "" && TEXT_EXTENSIONS.has(ext);
}
