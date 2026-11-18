#!/usr/bin/env node
// Deterministic TCP fault injector between each runner container and the
// service listener. TLS stays end to end; this only moves bytes.
//   node chaos-proxy.mjs <control-port> name=listenPort:targetPort ...
// Control (127.0.0.1): POST /<name>/sever | /block | /allow, GET /<name>/status
import { createServer as tcp, connect } from "node:net";
import { createServer as http } from "node:http";

const [controlPort, ...specs] = process.argv.slice(2);
const lanes = new Map();
for (const spec of specs) {
  const [name, ports] = spec.split("=");
  const [listen, target] = ports.split(":").map(Number);
  const lane = { name, target, blocked: false, pairs: new Set(), accepted: 0 };
  lane.server = tcp((client) => {
    lane.accepted += 1;
    if (lane.blocked) return client.destroy();
    const upstream = connect(lane.target, "127.0.0.1");
    const pair = [client, upstream];
    lane.pairs.add(pair);
    const end = () => {
      lane.pairs.delete(pair);
      client.destroy();
      upstream.destroy();
    };
    client.on("error", end).on("close", end);
    upstream.on("error", end).on("close", end);
    client.pipe(upstream);
    upstream.pipe(client);
  }).listen(listen, "0.0.0.0");
  lanes.set(name, lane);
}
const sever = (lane) => {
  for (const [a, b] of lane.pairs) (a.destroy(), b.destroy());
  lane.pairs.clear();
};
http((req, res) => {
  const [, name, action] = req.url.split("/");
  const lane = lanes.get(name);
  if (!lane) return res.writeHead(404).end();
  if (action === "sever") sever(lane);
  else if (action === "block") ((lane.blocked = true), sever(lane));
  else if (action === "allow") lane.blocked = false;
  else if (action !== "status") return res.writeHead(404).end();
  res.writeHead(200, { "content-type": "application/json" }).end(
    JSON.stringify({
      blocked: lane.blocked,
      open: lane.pairs.size,
      accepted: lane.accepted,
    })
  );
}).listen(Number(controlPort), "127.0.0.1", () => console.log("ready"));
