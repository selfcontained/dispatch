import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";

/** Public bootstrap downloads deliberately expose only the public CA/profile. */
export async function registerLocalTrustRoutes(
  app: FastifyInstance,
  directory: string
): Promise<void> {
  const ca = new X509Certificate(
    readFileSync(path.join(directory, "ca/cert.pem"))
  );
  const headers = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
  app.get("/trust/dispatch-ca.cer", async (_, reply) =>
    reply
      .headers(headers)
      .header("Content-Disposition", 'attachment; filename="dispatch-ca.cer"')
      .type("application/pkix-cert")
      .send(ca.raw)
  );
  const profile = readFileSync(path.join(directory, "ca/trust.mobileconfig"));
  app.get("/trust/dispatch.mobileconfig", async (_, reply) =>
    reply
      .headers(headers)
      .header(
        "Content-Disposition",
        'attachment; filename="dispatch.mobileconfig"'
      )
      .type("application/x-apple-aspen-config")
      .send(profile)
  );
  app.get("/trust", async (_, reply) =>
    reply.headers(headers).type("text/html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Trust this Dispatch server</title><style>
:root{color-scheme:light dark;font-family:system-ui,sans-serif}body{max-width:680px;margin:48px auto;padding:0 24px;line-height:1.6}h1{line-height:1.2}h2{margin-top:32px}a{color:light-dark(#185ac2,#90bbff)}.downloads{display:flex;flex-wrap:wrap;gap:12px}.downloads a{padding:10px 16px;border:1px solid currentColor;border-radius:8px;text-decoration:none}code{display:block;overflow-wrap:anywhere;font-size:12px}details{margin:24px 0}summary{cursor:pointer;font-weight:600}li{margin:8px 0}
</style></head><body>
<h1>Trust this Dispatch server</h1>
<p>Install this Dispatch installation’s local CA once on each device. Updated server certificates and changes to connection addresses will remain trusted.</p>
<p>You can also export these files from <strong>Dispatch on your Mac → Settings → Network</strong> and transfer them with AirDrop. This avoids needing to open an untrusted HTTPS page first.</p>
<div class="downloads"><a href="/trust/dispatch.mobileconfig">Download Apple trust profile</a><a href="/trust/dispatch-ca.cer">Download CA certificate</a></div>
<h2>iPhone and iPad</h2><ol>
<li>Download or AirDrop the Apple trust profile from your Mac.</li>
<li>Open Settings → General → VPN &amp; Device Management and install the downloaded profile.</li>
<li>Open Settings → General → About → Certificate Trust Settings. Enable full trust for the Dispatch Local CA.</li>
<li>Reopen Dispatch in Safari using the same server address.</li></ol>
<h2>Mac</h2><ol><li>Download the CA certificate and open it in Keychain Access. Add it to your login keychain.</li>
<li>Open the Dispatch Local CA certificate, expand Trust, and set Secure Sockets Layer (SSL) to Always Trust. Approve the change when macOS asks.</li><li>Reopen Dispatch in your browser.</li></ol>
<details><summary>Verify the certificate</summary><p>Compare this SHA-256 fingerprint with the one shown in Dispatch’s Network settings on the serving Mac before trusting it.</p><code>${ca.fingerprint256}</code>
<p>Only install a CA from a Dispatch installation you control. Its signing key stays on the serving Mac. A CA grants certificate trust on your device; it does not grant access to Dispatch or replace its password.</p></details>
<details><summary>Address changes and removing trust</summary><p>Use an IP address selected in Dispatch’s Network settings, or the Mac’s hostname. Saved network changes apply when the server next starts. Dispatch replaces the server certificate when necessary while preserving the CA.</p>
<p>To remove trust on iPhone or iPad, remove the Dispatch profile under VPN &amp; Device Management. On Mac, remove the Dispatch Local CA from Keychain Access. Reinstalling the app preserves trust if its data folder is preserved; replacing the CA requires trusting it again.</p></details>
<p><a href="/">Open Dispatch</a></p></body></html>`)
  );
}
