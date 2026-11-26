import { launchRunner } from "@dispatch/runner-client/launcher";
import { assets } from "../../src/standalone.js";
const dir = process.cwd();
const child = await launchRunner({
  command: [...process.argv.slice(2), "local-runner"],
  env: process.env,
  start: {
    build: {
      version: assets.build.version,
      ...(assets.build.revision && { revision: assets.build.revision }),
    },
    roots: { state: dir, files: dir },
    config: { runnerId: "local", displayName: "Fixture", engines: [] },
  },
});
try {
  await child.fence(true, 5000);
  await child.fence(false, 5000);
} finally {
  await child.close(2000);
}
