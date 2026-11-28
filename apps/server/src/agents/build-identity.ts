import { buildRevision, packageVersion } from "../generated/runtime-assets.js";

import type { BuildIdentity } from "@dispatch/runner-protocol/build-identity";
export {
  type BuildIdentity,
  isBuildIdentity,
  isHostInstanceId,
} from "@dispatch/runner-protocol/build-identity";

export const embeddedBuild: BuildIdentity = {
  version: packageVersion,
  revision: buildRevision,
};
