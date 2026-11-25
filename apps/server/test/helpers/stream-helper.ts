import { readFileSync } from "node:fs";

/** Use the same repository asset the release build embeds in the runner. */
export const streamHelper = readFileSync(
  new URL("../../../../bin/dispatch-stream", import.meta.url),
  "utf8"
);
