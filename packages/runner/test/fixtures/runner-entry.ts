/* The runner binary for process tests: its build comes from the environment. */
import { runCli } from "../../src/cli.js";

const build = JSON.parse(
  process.env.RUNNER_TEST_BUILD ?? '{"version":"0.0.0-test"}'
) as { version: string; revision?: string };
await runCli(process.argv.slice(2), { build });
