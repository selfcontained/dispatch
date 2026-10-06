import { spawn } from "node:child_process";
import { once } from "node:events";
import { request } from "node:http";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

const staticRoutesPath = fileURLToPath(
  new URL("../src/routes/static.ts", import.meta.url)
);
const serverRoot = fileURLToPath(new URL("..", import.meta.url));
const javascript = "export const message = 'production asset';\n".repeat(6000);

function fetchRaw(url: string, method: string, encoding: string) {
  return new Promise<{
    headers: import("node:http").IncomingHttpHeaders;
    body: Buffer;
    status: number | undefined;
  }>((resolve, reject) => {
    const req = request(
      url,
      { method, headers: { "accept-encoding": encoding } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () =>
          resolve({
            headers: res.headers,
            body: Buffer.concat(chunks),
            status: res.statusCode,
          })
        );
      }
    );
    req.setTimeout(5000, () =>
      req.destroy(new Error("HTTP request timed out"))
    );
    req.on("error", reject);
    req.end();
  });
}

describe("Bun production static HEAD responses", () => {
  it.each(["br", "gzip", "identity"])(
    "HEAD describes the actual %s GET representation",
    async (encoding) => {
      // Exercise real HTTP under Bun, even when Vitest itself runs under Node.
      // Injection does not reproduce Bun's Content-Length: 0 stream behavior.
      // The input is larger than fastify-compress's largest default sync threshold.
      const child = spawn(
        "bun",
        [
          "--eval",
          `
      import Fastify from 'fastify';
      import { registerStaticRoutes } from ${JSON.stringify(staticRoutesPath)};
      const app = Fastify();
      await registerStaticRoutes(app, {
        getCachedIndexHtml: () => '<html></html>',
        getCachedManifest: () => '{}',
        staticAssets: new Map([['/assets/large.js', {
          contentType: 'text/javascript', body: ${JSON.stringify("export const message = 'production asset';\n")}.repeat(6000)
        }]])
      });
      console.log(await app.listen({ port: 0, host: '127.0.0.1' }));
      process.on('SIGTERM', async () => { await app.close(); process.exit(0); });
    `,
        ],
        { cwd: serverRoot, stdio: ["ignore", "pipe", "pipe"] }
      );
      const exited = once(child, "exit");
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      try {
        const address = await new Promise<string>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`Bun startup timed out: ${stderr}`)),
            10000
          );
          let stdout = "";
          child.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
          });
          child.once("exit", (code) => {
            clearTimeout(timer);
            reject(new Error(`Bun exited (${code}): ${stderr}`));
          });
          child.stdout.on("data", (chunk) => {
            stdout += String(chunk);
            const url = stdout.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
            if (url) {
              clearTimeout(timer);
              resolve(url);
            }
          });
        });
        const url = `${address}/assets/large.js`;
        const head = await fetchRaw(url, "HEAD", encoding);
        const get = await fetchRaw(url, "GET", encoding);
        expect(head.status).toBe(200);
        expect(get.status).toBe(200);
        expect(head.body.length).toBe(0);
        expect(Number(head.headers["content-length"])).toBe(get.body.length);
        expect(head.headers["content-encoding"]).toBe(
          get.headers["content-encoding"]
        );
        expect(head.headers.vary).toBe(get.headers.vary);
        const decoded =
          encoding === "br"
            ? brotliDecompressSync(get.body)
            : encoding === "gzip"
              ? gunzipSync(get.body)
              : get.body;
        expect(decoded.toString()).toBe(javascript);
      } finally {
        child.kill("SIGTERM");
        await exited;
      }
    }
  );
});
