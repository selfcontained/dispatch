import { GitHubPrError } from "../github/pr.js";
import { GitWorktreeError } from "../git/worktree.js";
import { errorMessage } from "../lib/error-message.js";

export function toToolError(error: unknown): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  const message =
    error instanceof GitWorktreeError || error instanceof GitHubPrError
      ? error.message
      : errorMessage(error);

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
