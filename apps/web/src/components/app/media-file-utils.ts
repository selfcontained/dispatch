const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".csv",
  ".log",
  ".xml",
  ".html",
  ".css",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".py",
  ".go",
  ".rs",
  ".sh",
  ".sql",
  ".diff",
  ".patch",
  ".env",
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
]);

export function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot).toLowerCase();
}

export function isTextFile(name: string): boolean {
  const ext = fileExtension(name);
  return ext !== "" && TEXT_EXTENSIONS.has(ext);
}

const TIMESTAMP_RE = /-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-\d+/;

export function stripTimestamp(name: string): string {
  return name.replace(TIMESTAMP_RE, "");
}
