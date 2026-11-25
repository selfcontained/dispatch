import { DefaultBranchFiles as Files } from "../../src/agents/default-branch-files.js";
import { toPersonaDefinition } from "../../src/personas/loader.js";
export class DefaultBranchFiles extends Files {
  override get(
    cwd: string,
    directories: string[],
    wait: boolean,
    parseDefinition = toPersonaDefinition
  ) {
    return super.get(cwd, directories, wait, parseDefinition);
  }
}
