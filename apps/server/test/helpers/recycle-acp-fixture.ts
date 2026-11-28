import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createFakeAcpAgent } from "./fake-acp-agent.js";

const fake = createFakeAcpAgent({
  backgroundTasks: true,
  async turn(prompt, emit) {
    const session =
      fake.seen.resumeSession.at(-1) ?? fake.seen.newSession.at(-1)!;
    const resumed = "sessionId" in session ? session.sessionId : "sess_1";
    await emit({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: `${resumed}: ${prompt}` },
    });
    if (prompt.includes("hold-until-signal")) {
      while (!existsSync(path.join(session.cwd, "finish-turn")))
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (prompt.includes("hold-turn"))
      await new Promise((resolve) => setTimeout(resolve, 1200));
    return "end_turn";
  },
});
/** A file that must exist before this engine answers its host. */
const attached = process.argv[2];
while (attached && !existsSync(attached)) {
  if (!existsSync(path.dirname(attached))) process.exit(0);
  await new Promise((resolve) => setTimeout(resolve, 25));
}
process.stdin.pipe(fake.child.stdin);
fake.child.stdout.pipe(process.stdout);
process.stdin.once("end", () => process.exit(0));

setInterval(() => {
  const session = fake.seen.resumeSession.at(-1) ?? fake.seen.newSession.at(-1);
  if (!session) return;
  const file = path.join(session.cwd, "recycle-command");
  let command: string;
  try {
    command = readFileSync(file, "utf8");
    renameSync(file, file + ".read");
  } catch {
    return;
  }
  const sessionId = "sessionId" in session ? session.sessionId : "sess_1";
  if (command === "ask") {
    void fake.ask(sessionId).then(() => writeFileSync(file + ".answered", ""));
  } else {
    fake.wireUpdate(sessionId, JSON.parse(command));
  }
}, 25);
