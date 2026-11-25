import { generateKeyPairSync } from "node:crypto";

export function generateRunnerKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  return {
    key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

export { normalizeFingerprint } from "@dispatch/runner-protocol";
