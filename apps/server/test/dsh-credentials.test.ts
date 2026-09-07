import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  CODEX_GRANT_KEY,
  credentialsPath,
  readCodexGrant,
  readGrantKeys,
} from "../src/agents/dsh/credentials.js";

let tmp = "";
afterEach(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
  tmp = "";
});

const STORE = `version: 1

refs:
  OPENAI_API_KEY: sk-test

records:
  llm-pi-ai/openai-codex:
    kind: grant
    payload:
      type: oauth
      access: eyJ.access
      refresh: rft_1
      expires: 1800000000000
      accountId: acct_1
  llm-pi-ai/amazon-bedrock:
    kind: api-key
    env:
      AWS_PROFILE: prod
`;

describe("dsh credential store", () => {
  it("reads record keys and the ChatGPT grant", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "dsh-cred-"));
    await writeFile(credentialsPath(tmp), STORE);
    expect([...(await readGrantKeys(tmp))]).toEqual([
      CODEX_GRANT_KEY,
      "llm-pi-ai/amazon-bedrock",
    ]);
    expect(await readCodexGrant(tmp)).toEqual({
      access: "eyJ.access",
      refresh: "rft_1",
      expires: 1800000000000,
      accountId: "acct_1",
    });
  });

  it("answers empty for a missing, malformed, or keyless store", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "dsh-cred-"));
    expect((await readGrantKeys(tmp)).size).toBe(0);
    expect(await readCodexGrant(tmp)).toBeNull();
    await writeFile(credentialsPath(tmp), "records: [not: a: map\n");
    expect((await readGrantKeys(tmp)).size).toBe(0);
    await writeFile(
      credentialsPath(tmp),
      "version: 1\nrecords:\n  llm-pi-ai/openai-codex:\n    kind: grant\n    payload:\n      type: oauth\n"
    );
    expect(await readCodexGrant(tmp)).toBeNull();
  });
});
