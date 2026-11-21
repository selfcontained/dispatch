import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
} from "node:crypto";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { runnerDevKeyDirectory } from "../apps/server/src/server/runner-dev-key.ts";

export function loadRunnerDevKey() {
  mkdirSync(runnerDevKeyDirectory, { recursive: true, mode: 0o700 });
  const privatePath = path.join(runnerDevKeyDirectory, "private.pem");
  const staging = mkdtempSync(path.join(runnerDevKeyDirectory, "key-"));
  try {
    let privateKey;
    try {
      privateKey = createPrivateKey(readFileSync(privatePath));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const candidate = path.join(staging, "private.pem");
      const generated = generateKeyPairSync("ed25519").privateKey;
      writeFileSync(
        candidate,
        generated.export({ format: "pem", type: "pkcs8" }),
        {
          mode: 0o600,
          flag: "wx",
        }
      );
      try {
        linkSync(candidate, privatePath);
      } catch (linkError) {
        if (linkError.code !== "EEXIST") throw linkError;
      }
      privateKey = createPrivateKey(readFileSync(privatePath));
    }
    if (privateKey.asymmetricKeyType !== "ed25519")
      throw new Error("The runner development signing key must be Ed25519");
    const publicKey = createPublicKey(privateKey).export({
      format: "pem",
      type: "spki",
    });
    const publicPath = path.join(staging, "public.pem");
    writeFileSync(publicPath, publicKey);
    renameSync(publicPath, path.join(runnerDevKeyDirectory, "public.pem"));
    return { privateKey, publicKey };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
