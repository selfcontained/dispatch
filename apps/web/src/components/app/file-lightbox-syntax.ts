import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import dart from "highlight.js/lib/languages/dart";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import elixir from "highlight.js/lib/languages/elixir";
import erlang from "highlight.js/lib/languages/erlang";
import go from "highlight.js/lib/languages/go";
import graphql from "highlight.js/lib/languages/graphql";
import haskell from "highlight.js/lib/languages/haskell";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import lua from "highlight.js/lib/languages/lua";
import makefile from "highlight.js/lib/languages/makefile";
import markdown from "highlight.js/lib/languages/markdown";
import nim from "highlight.js/lib/languages/nim";
import objectivec from "highlight.js/lib/languages/objectivec";
import perl from "highlight.js/lib/languages/perl";
import php from "highlight.js/lib/languages/php";
import powershell from "highlight.js/lib/languages/powershell";
import protobuf from "highlight.js/lib/languages/protobuf";
import python from "highlight.js/lib/languages/python";
import r from "highlight.js/lib/languages/r";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scala from "highlight.js/lib/languages/scala";
import scss from "highlight.js/lib/languages/scss";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

import { fileExtension } from "@/components/app/file-utils";

const LANGUAGES = {
  bash,
  c,
  cpp,
  csharp,
  css,
  dart,
  diff,
  dockerfile,
  elixir,
  erlang,
  go,
  graphql,
  haskell,
  ini,
  java,
  javascript,
  json,
  kotlin,
  lua,
  makefile,
  markdown,
  nim,
  objectivec,
  perl,
  php,
  powershell,
  protobuf,
  python,
  r,
  ruby,
  rust,
  scala,
  scss,
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
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".pyi": "python",
  ".go": "go",
  ".rs": "rust",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  ".bashrc": "bash",
  ".zshrc": "bash",
  ".profile": "bash",
  ".env": "bash",
  ".ps1": "powershell",
  ".json": "json",
  ".jsonc": "json",
  ".json5": "json",
  ".webmanifest": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "ini",
  ".html": "xml",
  ".htm": "xml",
  ".xml": "xml",
  ".svg": "xml",
  ".plist": "xml",
  ".css": "css",
  ".scss": "scss",
  ".sql": "sql",
  ".graphql": "graphql",
  ".gql": "graphql",
  ".proto": "protobuf",
  ".md": "markdown",
  ".markdown": "markdown",
  ".mdx": "markdown",
  ".swift": "swift",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".java": "java",
  ".scala": "scala",
  ".cs": "csharp",
  ".dart": "dart",
  ".c": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".h": "c",
  ".hpp": "cpp",
  ".hh": "cpp",
  ".rb": "ruby",
  ".rake": "ruby",
  ".gemspec": "ruby",
  ".php": "php",
  ".pl": "perl",
  ".pm": "perl",
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
  ".gitconfig": "ini",
  ".editorconfig": "ini",
  ".npmrc": "ini",
  ".nim": "nim",
  ".m": "objectivec",
  ".mm": "objectivec",
  ".dockerfile": "dockerfile",
  ".mk": "makefile",
};

// Conventional extensionless names, matched case-insensitively on the basename.
const FILENAME_TO_LANG: Record<string, string> = {
  dockerfile: "dockerfile",
  containerfile: "dockerfile",
  makefile: "makefile",
  gnumakefile: "makefile",
  gemfile: "ruby",
  rakefile: "ruby",
};

function languageForFileName(fileName: string): string | undefined {
  const baseName = (fileName.split("/").pop() ?? "").toLowerCase();
  return FILENAME_TO_LANG[baseName] ?? EXT_TO_LANG[fileExtension(baseName)];
}

// Every language registered above is supported by its canonical highlight.js
// name (including `go` and highlight.js's `golang` alias). These only cover
// popular Markdown fence aliases not supplied by those grammars.
const FENCE_LANGUAGE_ALIASES: Record<string, string> = {
  js: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  shell: "bash",
  shellscript: "bash",
  yml: "yaml",
  html: "xml",
  svg: "xml",
  md: "markdown",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "bash",
};

export function highlightCodeLanguage(
  content: string,
  language?: string
): string | null {
  const requestedLanguage = language
    ?.replace(/^language-/, "")
    .trim()
    .toLowerCase();
  const normalizedLanguage = requestedLanguage
    ? (FENCE_LANGUAGE_ALIASES[requestedLanguage] ?? requestedLanguage)
    : undefined;

  if (normalizedLanguage && hljs.getLanguage(normalizedLanguage)) {
    try {
      return hljs.highlight(content, { language: normalizedLanguage }).value;
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

/**
 * The registered highlight.js language for a file name or fence language,
 * or null when highlighting would fall back to auto-detection: callers
 * that color line by line want a definite language or none at all.
 */
export function resolveHighlightLanguage(input: {
  fileName?: string;
  language?: string;
}): string | null {
  const fromFile = input.fileName
    ? languageForFileName(input.fileName)
    : undefined;
  const requested = (fromFile ?? input.language)
    ?.replace(/^language-/, "")
    .trim()
    .toLowerCase();
  if (!requested) return null;
  const normalized = FENCE_LANGUAGE_ALIASES[requested] ?? requested;
  return hljs.getLanguage(normalized) ? normalized : null;
}

export function highlightCode(
  content: string,
  fileName: string
): string | null {
  return highlightCodeLanguage(content, languageForFileName(fileName));
}
