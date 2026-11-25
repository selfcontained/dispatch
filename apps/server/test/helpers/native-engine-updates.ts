import { EngineUpdateOperations as Coordinator } from "../../src/agents/engine-update-operations.js";
import {
  inspectInstallation,
  observedUpdateRunner,
} from "../../src/agents/engine-updates.js";
import {
  engineStatuses,
  engineVersion,
  clearEngineVersionCache,
} from "../../src/agents/engine-availability.js";
export * from "../../src/agents/engine-updates.js";
export * from "../../src/agents/engine-update-operations.js";
export class EngineUpdateOperations extends Coordinator {
  constructor(
    store: ConstructorParameters<typeof Coordinator>[0],
    options: Partial<ConstructorParameters<typeof Coordinator>[1]> = {}
  ) {
    super(store, {
      prepare: (id, overrides) =>
        engineStatuses(overrides).then((statuses) =>
          inspectInstallation(statuses.find((status) => status.id === id)!)
        ),
      runner: observedUpdateRunner,
      verify: (bin) => engineVersion(bin),
      clearEngineVersionCache,
      ...options,
    });
  }
}
