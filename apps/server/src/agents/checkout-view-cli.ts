import {
  isCheckoutView,
  MAX_CHECKOUT_VIEW_BYTES,
} from "@dispatch/runner-protocol";
import { WorkspaceError } from "../files/workspace-view.js";
import { readCheckoutView } from "./checkout-view.js";

export async function runCheckoutViewCli(cwd: string, managed: boolean) {
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const bytes of process.stdin) {
      const buf = Buffer.from(bytes);
      if ((size += buf.length) > 16 * 1024) throw new Error("Query too large");
      chunks.push(buf);
    }
    const view: unknown = JSON.parse(Buffer.concat(chunks).toString());
    if (!isCheckoutView(view)) throw new Error("Invalid checkout view");
    const output = JSON.stringify({
      data: await readCheckoutView(cwd, view, managed),
    });
    if (Buffer.byteLength(output) + 1 > MAX_CHECKOUT_VIEW_BYTES)
      throw new WorkspaceError("Checkout response is too large.", 413);
    process.stdout.write(output + "\n");
  } catch (error) {
    if (error instanceof WorkspaceError)
      process.stdout.write(
        JSON.stringify({ status: error.status, error: error.message }) + "\n"
      );
    else {
      process.stderr.write("Unable to read the session checkout.\n");
      process.exitCode = 1;
    }
  }
}
