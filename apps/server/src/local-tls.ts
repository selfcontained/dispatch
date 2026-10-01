import { execFileSync } from "node:child_process";
import {
  createPrivateKey,
  randomBytes,
  randomUUID,
  X509Certificate,
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import { rootCertificates } from "node:tls";
import type { TlsConfig } from "./config.js";

const month = 30 * 24 * 60 * 60 * 1000;
const openssl = "/usr/bin/openssl";

function run(args: string[]): Buffer {
  return execFileSync(openssl, args, {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
}

function atomicWrite(file: string, data: string | Buffer) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, data, { mode: 0o600, flag: "wx" });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Preserve public roots and an existing custom trust bundle for agent tools. */
export function localAgentCaBundle(
  caPath: string,
  existingBundle?: string
): string {
  const output = path.join(path.dirname(caPath), "agent-ca.pem");
  const certificates = [...rootCertificates];
  if (existingBundle && existingBundle !== output)
    certificates.push(readFileSync(existingBundle, "utf8"));
  certificates.push(readFileSync(caPath, "utf8"));
  atomicWrite(output, certificates.join("\n"));
  return output;
}

/** Stop polling after renewal; the app supervisor loads it in a new worker. */
export function watchLocalTls(input: {
  directory: string;
  hosts: string[];
  certificate: Buffer;
  onRenewed: () => void;
  onError: (error: unknown) => void;
}): () => void {
  const timer = setInterval(
    () => {
      try {
        const next = ensureLocalTls(input.directory, input.hosts);
        if (!next.cert.equals(input.certificate)) {
          clearInterval(timer);
          input.onRenewed();
        }
      } catch (error) {
        input.onError(error);
      }
    },
    60 * 60 * 1000
  );
  timer.unref();
  return () => clearInterval(timer);
}

/** Only concrete connection addresses belong in SANs; wildcard binds do not. */
export function localTlsNames(
  hosts: string[],
  hostname = os.hostname()
): string[] {
  const addresses = hosts.flatMap((host) =>
    host === "0.0.0.0" || host === "::"
      ? Object.values(os.networkInterfaces()).flatMap((entries) =>
          (entries ?? []).map((entry) => entry.address.split("%")[0]!)
        )
      : [host]
  );
  const dns = ["localhost", hostname].filter((name) =>
    /^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(name)
  );
  return [
    ...new Set([
      ...dns.map((name) => `DNS:${name}`),
      ...["127.0.0.1", "::1", ...addresses]
        .filter((address) => isIP(address))
        .map((address) => `IP:${address}`),
    ]),
  ].sort();
}

/** One persistent CA per installation. Never silently replace a damaged CA. */
export function ensureLocalTls(
  directory: string,
  hosts: string[],
  now = Date.now()
): TlsConfig {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const caDirectory = path.join(directory, "ca");
  if (!existsSync(caDirectory)) {
    const stage = path.join(directory, `.ca-${randomUUID()}`);
    mkdirSync(stage, { mode: 0o700 });
    try {
      const id = randomUUID();
      const config = path.join(stage, "openssl.cnf");
      writeFileSync(
        config,
        `[req]\ndistinguished_name=dn\nx509_extensions=ca\nprompt=no\n[dn]\nCN=Dispatch Local CA ${id}\n[ca]\nbasicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n`,
        { mode: 0o600 }
      );
      run([
        "req",
        "-x509",
        "-newkey",
        "rsa:3072",
        "-nodes",
        "-sha256",
        "-days",
        "7300",
        "-config",
        config,
        "-keyout",
        path.join(stage, "key.pem"),
        "-out",
        path.join(stage, "cert.pem"),
      ]);
      // OpenSSL's output permissions are not guaranteed by the caller's umask.
      for (const name of ["key.pem", "cert.pem"])
        atomicWrite(
          path.join(stage, name),
          readFileSync(path.join(stage, name))
        );
      const root = new X509Certificate(
        readFileSync(path.join(stage, "cert.pem"))
      );
      writeFileSync(path.join(stage, "cert.cer"), root.raw, { mode: 0o600 });
      writeFileSync(
        path.join(stage, "trust.mobileconfig"),
        trustProfile(root, id),
        { mode: 0o600 }
      );
      rmSync(config);
      renameSync(stage, caDirectory);
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  }
  const ca = new X509Certificate(
    readFileSync(path.join(caDirectory, "cert.pem"))
  );
  const caKey = createPrivateKey(
    readFileSync(path.join(caDirectory, "key.pem"))
  );
  if (
    !ca.ca ||
    !ca.checkPrivateKey(caKey) ||
    Date.parse(ca.validTo) <= now + month
  ) {
    throw new Error(
      "Dispatch's local CA is invalid or expiring. Restore its TLS directory from backup; replacing it requires devices to trust a new CA."
    );
  }
  const names = localTlsNames(hosts);
  const keyPath = path.join(directory, "server-key.pem");
  const certPath = path.join(directory, "server-cert.pem");
  let reusable = false;
  try {
    const cert = new X509Certificate(readFileSync(certPath));
    reusable =
      cert.verify(ca.publicKey) &&
      cert.checkPrivateKey(createPrivateKey(readFileSync(keyPath))) &&
      Date.parse(cert.validTo) > now + month &&
      readFileSync(path.join(directory, "names.json"), "utf8") ===
        JSON.stringify(names);
  } catch {
    /* First start or an interrupted leaf renewal; keep the CA. */
  }
  if (!reusable) {
    const stage = path.join(directory, `.server-${randomUUID()}`);
    mkdirSync(stage, { mode: 0o700 });
    try {
      const key = path.join(stage, "key.pem");
      const csr = path.join(stage, "request.pem");
      const config = path.join(stage, "openssl.cnf");
      writeFileSync(
        config,
        `[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=Dispatch\n[server]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\nsubjectAltName=${names.join(",")}\n`,
        { mode: 0o600 }
      );
      // Keeping the leaf key stable permits an atomic certificate-only renewal.
      if (existsSync(keyPath))
        writeFileSync(key, readFileSync(keyPath), { mode: 0o600 });
      else {
        run(["genrsa", "-out", key, "2048"]);
        atomicWrite(keyPath, readFileSync(key));
      }
      run([
        "req",
        "-new",
        "-sha256",
        "-key",
        key,
        "-config",
        config,
        "-out",
        csr,
      ]);
      const output = path.join(stage, "cert.pem");
      run([
        "x509",
        "-req",
        "-in",
        csr,
        "-CA",
        path.join(caDirectory, "cert.pem"),
        "-CAkey",
        path.join(caDirectory, "key.pem"),
        "-set_serial",
        `0x${randomBytes(16).toString("hex")}`,
        "-days",
        "365",
        "-sha256",
        "-extfile",
        config,
        "-extensions",
        "server",
        "-out",
        output,
      ]);
      atomicWrite(certPath, readFileSync(output));
      atomicWrite(path.join(directory, "names.json"), JSON.stringify(names));
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  }
  return { cert: readFileSync(certPath), key: readFileSync(keyPath) };
}

function trustProfile(certificate: X509Certificate, id: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>PayloadType</key><string>Configuration</string>
<key>PayloadVersion</key><integer>1</integer>
<key>PayloadIdentifier</key><string>dev.dispatch.local-trust.${id}</string>
<key>PayloadUUID</key><string>${id}</string>
<key>PayloadDisplayName</key><string>Dispatch Local Certificate Trust</string>
<key>PayloadDescription</key><string>Trust the local CA for your Dispatch installation. On iOS, also enable full trust in Certificate Trust Settings.</string>
<key>PayloadContent</key><array><dict>
<key>PayloadType</key><string>com.apple.security.root</string>
<key>PayloadVersion</key><integer>1</integer>
<key>PayloadIdentifier</key><string>dev.dispatch.local-trust.${id}.root</string>
<key>PayloadUUID</key><string>${randomUUID()}</string>
<key>PayloadDisplayName</key><string>Dispatch Local CA ${id.slice(0, 8)}</string>
<key>PayloadContent</key><data>${certificate.raw.toString("base64")}</data>
</dict></array></dict></plist>`;
}
