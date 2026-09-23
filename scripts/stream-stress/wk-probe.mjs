#!/usr/bin/env node
// WebKit memory for a stream-stress root (see drive.mjs): opens it in the
// system WebKit (wkhost.swift), loads older pages, scrolls the whole feed,
// then leaves it, and reads the WebContent process footprint by category
// (`footprint`): graphics is the compositing memory Safari grew by.
//
//   swiftc -O scripts/stream-stress/wkhost.swift -o /tmp/wkhost
//   node scripts/stream-stress/wk-probe.mjs --web http://127.0.0.1:PORT \
//     --setup setup.json --label base [--host /tmp/wkhost] [--older 5]
import { execSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import readline from "node:readline";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => (arg.startsWith("--") ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs), [])
);
const setup = JSON.parse(readFileSync(args.setup, "utf8"));
const LABEL = args.label ?? "run";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const contentPids = () => new Set(execSync("pgrep -f com.apple.WebKit.WebContent || true").toString().split("\n").filter(Boolean));
const before = contentPids();
const host = spawn(args.host ?? "/tmp/wkhost", [], { stdio: ["pipe", "pipe", "inherit"] });
const lines = readline.createInterface({ input: host.stdout });
const waiting = [];
lines.on("line", (line) => waiting.shift()?.(line));
const reply = () => new Promise((resolve) => waiting.push(resolve));
await reply(); // READY
const send = async (command) => {
  host.stdin.write(command.replace(/\n/g, " ") + "\n");
  return reply();
};
const js = async (body) => (await send(`js ${body}`)).replace(/^RESULT /, "");
const go = (id) => js(`history.pushState({}, "", "/agents/${id}"); dispatchEvent(new PopStateEvent("popstate")); return 1`);

await send(`load ${args.web}/agents/${setup.reviewers?.[0] ?? setup.root}`);
await sleep(6000);
const pids = [...contentPids()].filter((pid) => !before.has(pid));
// A stylesheet to switch a suspect off while bisecting (e.g. "--css '...'").
if (args.css) await js(`const s=document.createElement("style"); s.textContent=${JSON.stringify(args.css)}; document.head.appendChild(s); return 1`);

function footprint() {
  const mb = (v, u) => Number(v) * { GB: 1024, MB: 1, KB: 1 / 1024, B: 1 / 1048576 }[u];
  const out = { totalMB: 0, graphicsMB: 0, mallocMB: 0, jsMB: 0 };
  for (const pid of pids) {
    const text = execSync(`footprint -p ${pid} 2>/dev/null || true`).toString();
    const total = /Footprint:\s*([\d.]+)\s*(KB|MB|GB)/.exec(text);
    if (total) out.totalMB += mb(total[1], total[2]);
    for (const m of text.matchAll(/^\s*([\d.]+)\s*(B|KB|MB|GB)\s+[\d.]+\s*(?:B|KB|MB|GB)\s+[\d.]+\s*(?:B|KB|MB|GB)\s+\d+\s+(.*)$/gm)) {
      const key = /graphics/.test(m[3]) ? "graphicsMB" : /WebKit malloc/.test(m[3]) ? "mallocMB" : /Gigacage/.test(m[3]) ? "jsMB" : null;
      if (key) out[key] += mb(m[1], m[2]);
    }
  }
  for (const key of Object.keys(out)) out[key] = +out[key].toFixed(1);
  return out;
}
async function sample(phase) {
  await sleep(2000);
  const rows = Number(await js(`return document.querySelectorAll("[data-testid=chat-scroll] [data-chat-entry-id]").length`));
  const els = Number(await js(`return document.getElementsByTagName("*").length`));
  console.log(JSON.stringify({ label: LABEL, phase, rows, els, ...footprint() }));
}

await sample("other-agent");
await go(setup.root);
await sleep(6000);
await sample("root");
for (let i = 0; i < Number(args.older ?? 5); i += 1) {
  await js(`const b=[...document.querySelectorAll("[data-testid=chat-scroll] button")].find(b=>/Load older/.test(b.textContent)); if(b) b.click(); return !!b`);
  await sleep(1500);
}
await sample("older");
const scroll = `const sc=document.querySelector("[data-testid=chat-scroll]"); for(let y=sc.scrollHeight;y>=0;y-=600){sc.scrollTop=y; await new Promise(r=>setTimeout(r,40));} for(let y=0;y<=sc.scrollHeight;y+=600){sc.scrollTop=y; await new Promise(r=>setTimeout(r,40));} return sc.scrollHeight`;
await js(scroll);
await sample("scrolled");
await go(setup.reviewers?.[0] ?? setup.root);
await sleep(8000);
await sample("left");
host.stdin.write("quit\n");
await sleep(500);
process.exit(0);
