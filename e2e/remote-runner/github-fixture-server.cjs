// Tiny authenticated CGI origin for real Git fetches/pushes in a test container.
const https = require("node:https");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const root = "/tmp/private-git";
const auth =
  "Basic " +
  Buffer.from("fixture-scratch:test-only-scratch").toString("base64");

https
  .createServer(
    {
      key: fs.readFileSync(root + "/key"),
      cert: fs.readFileSync(
        "/usr/local/share/ca-certificates/runner-test-github.crt"
      ),
    },
    async (req, res) => {
      const url = new URL(req.url, "https://github.com");
      if (
        !/^\/fixture-scratch\/private(?:\.git)?\/(info\/refs|git-(?:upload|receive)-pack)$/.test(
          url.pathname
        )
      ) {
        return res.writeHead(404).end();
      }
      if (req.headers.authorization !== auth) {
        return res
          .writeHead(401, { "WWW-Authenticate": 'Basic realm="fixture"' })
          .end();
      }
      const body = [];
      for await (const chunk of req) body.push(chunk);
      const cgi = spawnSync("git", ["http-backend"], {
        input: Buffer.concat(body),
        env: {
          PATH: "/usr/bin:/bin",
          GIT_PROJECT_ROOT: root + "/repos",
          GIT_HTTP_EXPORT_ALL: "1",
          PATH_INFO: url.pathname.replace("/private/", "/private.git/"),
          QUERY_STRING: url.search.slice(1),
          REQUEST_METHOD: req.method,
          CONTENT_TYPE: req.headers["content-type"] || "",
          CONTENT_LENGTH: req.headers["content-length"] || "",
          REMOTE_USER: "fixture-scratch",
          HTTP_GIT_PROTOCOL: req.headers["git-protocol"] || "",
        },
      });
      const boundary = cgi.stdout.indexOf("\r\n\r\n");
      if (cgi.status !== 0 || boundary < 0) return res.writeHead(500).end();
      let status = 200;
      for (const line of cgi.stdout
        .subarray(0, boundary)
        .toString()
        .split("\r\n")) {
        const separator = line.indexOf(":");
        const key = line.slice(0, separator);
        const value = line.slice(separator + 1).trim();
        if (key === "Status") status = parseInt(value, 10);
        else res.setHeader(key, value);
      }
      res.writeHead(status).end(cgi.stdout.subarray(boundary + 4));
    }
  )
  .listen(443, "127.0.0.1");
