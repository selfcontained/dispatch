import { afterEach, describe, expect, it, vi } from "vitest";
import { X509Certificate } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, request } from "node:https";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import {
  ensureLocalTls,
  localTlsNames,
  localAgentCaBundle,
  watchLocalTls,
} from "../src/local-tls.js";
import { registerLocalTrustRoutes } from "../src/routes/local-trust.js";

const roots: string[] = [];
function directory() {
  const root = mkdtempSync(path.join(os.tmpdir(), "dispatch-local-tls-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("Mac local certificate trust", () => {
  it("requests one supervised restart after renewal and leaves unchanged certificates alone", () => {
    const root = directory();
    const tls = ensureLocalTls(root, ["127.0.0.1"]);
    const renewed = vi.fn();
    const failed = vi.fn();
    vi.useFakeTimers();
    const stop = watchLocalTls({
      directory: root,
      hosts: ["127.0.0.1"],
      certificate: tls.cert,
      onRenewed: renewed,
      onError: failed,
    });
    try {
      vi.advanceTimersByTime(60 * 60 * 1000);
      expect(renewed).not.toHaveBeenCalled();
      vi.setSystemTime(
        Date.parse(new X509Certificate(tls.cert).validTo) - 1000
      );
      vi.advanceTimersByTime(60 * 60 * 1000);
      expect(renewed).toHaveBeenCalledTimes(1);
      expect(failed).not.toHaveBeenCalled();
      vi.advanceTimersByTime(60 * 60 * 1000);
      expect(renewed).toHaveBeenCalledTimes(1);
    } finally {
      stop();
      vi.useRealTimers();
    }
  });
  it("includes local, public, and existing corporate roots in the agent bundle", () => {
    const root = directory();
    ensureLocalTls(root, ["127.0.0.1"]);
    const caPath = path.join(root, "ca/cert.pem");
    const bundle = readFileSync(
      localAgentCaBundle(caPath, caPath, path.join(root, "agent-ca.pem")),
      "utf8"
    );
    expect(bundle).toContain(readFileSync(caPath, "utf8"));
    expect(bundle.match(/BEGIN CERTIFICATE/g)!.length).toBeGreaterThan(10);
    expect(bundle).not.toContain("PRIVATE KEY");
  });
  it("keeps the CA and profile stable across address changes and leaf renewal", () => {
    const root = directory();
    const first = ensureLocalTls(root, ["127.0.0.1"]);
    const ca = readFileSync(path.join(root, "ca/cert.pem"));
    const profile = readFileSync(path.join(root, "ca/trust.mobileconfig"));
    expect(ensureLocalTls(root, ["127.0.0.1"]).cert).toEqual(first.cert);
    const second = ensureLocalTls(root, ["127.0.0.1", "192.168.1.23"]);
    const certificate = new X509Certificate(second.cert);
    expect(certificate.checkIP("192.168.1.23")).toBe("192.168.1.23");
    expect(certificate.checkIP("192.168.1.24")).toBeUndefined();
    expect(certificate.checkHost("localhost")).toBe("localhost");
    expect(certificate.verify(new X509Certificate(ca).publicKey)).toBe(true);
    const renewed = ensureLocalTls(
      root,
      ["127.0.0.1", "192.168.1.23"],
      Date.parse(certificate.validTo) - 1000
    );
    expect(renewed.cert).not.toEqual(second.cert);
    expect(renewed.key).toEqual(first.key);
    expect(readFileSync(path.join(root, "ca/cert.pem"))).toEqual(ca);
    expect(readFileSync(path.join(root, "ca/trust.mobileconfig"))).toEqual(
      profile
    );
    expect(profile.toString()).toContain(
      new X509Certificate(ca).raw.toString("base64")
    );
    expect(profile.toString()).not.toContain("PRIVATE KEY");
    for (const file of ["ca/key.pem", "server-key.pem"])
      expect(statSync(path.join(root, file)).mode & 0o777).toBe(0o600);
    expect(statSync(root).mode & 0o777).toBe(0o700);
  });

  it("never replaces a damaged CA with an untrusted new identity", () => {
    const root = directory();
    ensureLocalTls(root, ["127.0.0.1"]);
    const ca = readFileSync(path.join(root, "ca/cert.pem"));
    writeFileSync(path.join(root, "ca/key.pem"), "damaged");
    expect(() => ensureLocalTls(root, ["127.0.0.1"])).toThrow();
    expect(readFileSync(path.join(root, "ca/cert.pem"))).toEqual(ca);
  });

  it("serves real HTTPS verified by the CA and rejects other hostnames", async () => {
    const root = directory();
    const server = createServer(
      ensureLocalTls(root, ["127.0.0.1"]),
      (_, reply) => reply.end("ok")
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );
    const address = server.address() as { port: number };
    const get = (servername: string, ca?: Buffer) =>
      new Promise<string>((resolve, reject) => {
        request(
          { host: "127.0.0.1", port: address.port, servername, ca },
          (response) => {
            let body = "";
            response.on("data", (part) => {
              body += part;
            });
            response.on("end", () => resolve(body));
          }
        )
          .on("error", reject)
          .end();
      });
    try {
      const ca = readFileSync(path.join(root, "ca/cert.pem"));
      await expect(get("localhost", ca)).resolves.toBe("ok");
      await expect(get("unrelated.example", ca)).rejects.toThrow();
      await expect(get("localhost")).rejects.toThrow();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("exposes public bootstrap downloads and no signing keys", async () => {
    const root = directory();
    ensureLocalTls(root, ["127.0.0.1"]);
    const app = Fastify();
    await registerLocalTrustRoutes(app, root);
    try {
      const page = await app.inject("/trust");
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain("Certificate Trust Settings");
      const cert = await app.inject("/trust/dispatch-ca.cer");
      expect(cert.rawPayload).toEqual(
        readFileSync(path.join(root, "ca/cert.cer"))
      );
      const profile = await app.inject("/trust/dispatch.mobileconfig");
      expect(profile.headers["content-type"]).toContain(
        "application/x-apple-aspen-config"
      );
      expect(profile.body).not.toContain("PRIVATE KEY");
      expect((await app.inject("/trust/key.pem")).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("uses concrete addresses and excludes unsafe hostname input", () => {
    expect(localTlsNames(["127.0.0.1"], "my-mac.local")).toContain(
      "DNS:my-mac.local"
    );
    expect(
      localTlsNames(["127.0.0.1"], "bad\nsubjectAltName=DNS:evil.example")
    ).not.toContain("DNS:evil.example");
    expect(
      localTlsNames(["0.0.0.0", "::"]).some(
        (name) => name === "IP:0.0.0.0" || name === "IP:::"
      )
    ).toBe(false);
  });
});
