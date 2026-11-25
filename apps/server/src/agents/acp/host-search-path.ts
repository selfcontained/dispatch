import { withToolSearchPath } from "../../shared/lib/tool-environment.js";
import { withEngineBinDir } from "@dispatch/runner/host/engine-bin-dir";
import { isPackageBinDir } from "./package-bin-dir.js";

/**
 * Dispatch's engine search path, given to every agent host it starts: the
 * same tool fallbacks, engine bin directory and package-bin skip that
 * engine discovery uses.
 */
export const hostSearchPath = {
  withToolSearchPath,
  withEngineBinDir,
  isPackageBinDir,
};
