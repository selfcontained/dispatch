import { runCommand } from "../../../../packages/runner/src/workload/shared/lib/run-command.js";

const [node, mode] = process.argv.slice(2);
const script =
  mode === "output"
    ? `const { once } = require('node:events');
       (async () => {
         for (let i = 0; i < 2048; i++) {
           for (const stream of [process.stdout, process.stderr]) {
             if (!stream.write('x'.repeat(8192))) await once(stream, 'drain');
           }
         }
       })();`
    : mode === "exit"
      ? `process.stderr.write('x'.repeat(16384), () => process.exit(42));`
      : `process.stderr.write('install pending'); setInterval(() => {}, 1000);`;
try {
  const result = await runCommand(
    mode === "missing" ? "/dispatch/nonexistent-command" : node!,
    ["-e", script],
    { timeoutMs: mode === "timeout" ? 500 : 10_000 }
  );
  console.log(
    JSON.stringify({
      exitCode: result.exitCode,
      stdoutLength: result.stdout.length,
      stderrLength: result.stderr.length,
    })
  );
} catch (error) {
  console.log(
    JSON.stringify(
      error instanceof Error
        ? { ...error, message: error.message, name: error.name }
        : { message: String(error) }
    )
  );
}
