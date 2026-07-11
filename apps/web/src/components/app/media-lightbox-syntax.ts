import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import elixir from "highlight.js/lib/languages/elixir";
import erlang from "highlight.js/lib/languages/erlang";
import go from "highlight.js/lib/languages/go";
import haskell from "highlight.js/lib/languages/haskell";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import lua from "highlight.js/lib/languages/lua";
import markdown from "highlight.js/lib/languages/markdown";
import nim from "highlight.js/lib/languages/nim";
import objectivec from "highlight.js/lib/languages/objectivec";
import php from "highlight.js/lib/languages/php";
import python from "highlight.js/lib/languages/python";
import r from "highlight.js/lib/languages/r";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

import { fileExtension } from "@/components/app/media-file-utils";

const LANGUAGES = {
  bash,
  c,
  cpp,
  css,
  diff,
  elixir,
  erlang,
  go,
  haskell,
  ini,
  java,
  javascript,
  json,
  kotlin,
  lua,
  markdown,
  nim,
  objectivec,
  php,
  python,
  r,
  ruby,
  rust,
  sql,
  swift,
  typescript,
  xml,
  yaml,
};

for (const [name, language] of Object.entries(LANGUAGES)) {
  hljs.registerLanguage(name, language);
}

const EXT_TO_LANG: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".sh": "bash",
  ".bash": "bash",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "ini",
  ".html": "xml",
  ".xml": "xml",
  ".css": "css",
  ".sql": "sql",
  ".md": "markdown",
  ".swift": "swift",
  ".kt": "kotlin",
  ".java": "java",
  ".c": "c",
  ".cpp": "cpp",
  ".h": "c",
  ".hpp": "cpp",
  ".rb": "ruby",
  ".php": "php",
  ".lua": "lua",
  ".r": "r",
  ".ex": "elixir",
  ".exs": "elixir",
  ".erl": "erlang",
  ".hs": "haskell",
  ".diff": "diff",
  ".patch": "diff",
  ".ini": "ini",
  ".cfg": "ini",
  ".conf": "ini",
  ".nim": "nim",
  ".m": "objectivec",
};

export function highlightCode(
  content: string,
  fileName: string
): string | null {
  const language = EXT_TO_LANG[fileExtension(fileName)];
  if (language) {
    try {
      return hljs.highlight(content, { language }).value;
    } catch {
      // Fall through to auto-detection.
    }
  }

  try {
    return hljs.highlightAuto(content).value;
  } catch {
    return null;
  }
}
