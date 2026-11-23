// The rule lives beside the app's other host-free helpers so the app can
// send it as a runner's `exclude` patterns; Git callers keep this path.
export { isTestFile, TEST_FILE_PATTERNS } from "../lib/test-file-rule.js";
