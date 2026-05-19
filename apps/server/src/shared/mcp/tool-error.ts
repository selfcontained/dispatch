import { GitHubPrError } from "../github/pr.js";
import { GitWorktreeError } from "../git/worktree.js";

export function toToolError(error: unknown): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  const message =
    error instanceof GitWorktreeError || error instanceof GitHubPrError
      ? error.message
      : error instanceof Error
        ? error.message
        : String(error);

  return {
    content: [
      {
        type: "text",
        text: message,
      },
    ],
    isError: true,
  };
}
