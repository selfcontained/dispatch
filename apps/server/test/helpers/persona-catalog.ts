import {
  displayPath,
  type Req,
  type Runner,
} from "@dispatch/runner-protocol/contract";
import type { CheckoutCommandRunners } from "../../src/runners/directory.js";
import type { CommandRunner } from "../../src/shared/lib/run-command.js";
import { PersonaCatalogCache as Catalog } from "../../src/personas/catalog.js";
import { DefaultBranchFiles } from "./default-branch-files.js";
import { checkoutWorkload } from "./checkout-workload.js";
export * from "../../src/personas/catalog.js";

/** Test-only port wiring retains controlled Git/time inputs across the reroute. */
export class PersonaCatalogCache extends Catalog {
  private files: DefaultBranchFiles;
  constructor(run?: CommandRunner, now?: () => number) {
    super();
    this.files = new DefaultBranchFiles(run, now);
  }
  override get(cwd: string, wait = false, _runners?: CheckoutCommandRunners) {
    const files = this.files;
    const runner = {
      async call(op: string, raw: unknown, options?: { signal?: AbortSignal }) {
        if (op === "checkout.defaultFiles") {
          const request = raw as Req<"checkout.defaultFiles">;
          if (!("path" in request.target))
            throw new Error("Catalog fixture requires a folder target.");
          const { kind: _kind, ...reply } = await files.get(
            displayPath(request.target.path),
            request.dirs,
            request.wait
          );
          return reply;
        }
        if (op === "git.roots") {
          const { target, ...request } = raw as Req<"git.roots">;
          if (!("path" in target))
            throw new Error("Catalog fixture requires a folder target.");
          return checkoutWorkload.run(
            "git.roots",
            { directory: displayPath(target.path), request },
            options ?? {}
          );
        }
        throw new Error(`Unexpected catalog fixture operation: ${op}`);
      },
    } as unknown as Runner;
    return super.get(cwd, wait, { child: () => runner });
  }
}
