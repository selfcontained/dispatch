import { isCheckoutCommand } from "@dispatch/runner-protocol";
import { executeCheckoutCommand } from "../checkout-command-executor.js";
import { readCheckoutCommandFile } from "../checkout-inspection.js";

export async function runCheckoutCommandCli(
  cwd: string,
  session: string,
  configuredRoot?: string
) {
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const input of process.stdin) {
      const chunk = Buffer.from(input);
      size += chunk.length;
      if (size > 96 * 1024)
        throw new Error("Checkout command request is too large.");
      chunks.push(chunk);
    }
    const operation: unknown = JSON.parse(
      Buffer.concat(chunks).toString("utf8")
    );
    if (!isCheckoutCommand(operation))
      throw new Error("Invalid checkout command.");
    process.stdout.write(
      JSON.stringify(
        await executeCheckoutCommand(
          cwd,
          session,
          operation,
          (file) => readCheckoutCommandFile(cwd, file, { configuredRoot }),
          undefined,
          process.env.SHELL || "/bin/bash"
        )
      )
    );
  } catch (error) {
    process.stderr.write(
      (error instanceof Error
        ? error.message
        : "Checkout command failed."
      ).slice(0, 1024)
    );
    process.exitCode = 1;
  }
}
