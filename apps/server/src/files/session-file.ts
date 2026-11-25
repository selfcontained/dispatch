import type { Runner, SessionHandle } from "@dispatch/runner-protocol/contract";
import { displayPath } from "@dispatch/runner-protocol/contract";
import {
  takeSessionFileBytes,
  withSessionFileBlob,
  type SessionFileBlob,
} from "./session-file-blob.js";
import { digestSessionFile, sessionFileSource } from "./session-file-io.js";

export {
  openBoundedSessionFile,
  readSessionFile,
  digestSessionFile,
  sessionFileSource,
} from "./session-file-io.js";

/**
 * `files.put`: hand one file on this machine to a session and return the
 * path it opens there. The session's runner resolves the file (see
 * `SessionFileBlob`); the request's size and digest are the transport's.
 */
export async function putSessionFile(
  runner: Pick<Runner, "call">,
  session: SessionHandle,
  source: string,
  name: string,
  purpose: SessionFileBlob["purpose"]
): Promise<string> {
  const file: SessionFileBlob = {
    path: source,
    purpose,
    digest: () => digestSessionFile(source),
    source: (digest) => sessionFileSource(source, digest),
  };
  return withSessionFileBlob(file, async (blob) => {
    const { path } = await runner.call("files.put", {
      session,
      name,
      // The transport takes these from the file `blob` names, when it needs them.
      size: 0,
      digest: "",
      blob,
    });
    return displayPath(path);
  });
}

/** `files.get`: the bytes of a file in a session, at the path it named. */
export async function getSessionFile(
  runner: Pick<Runner, "call">,
  session: SessionHandle,
  path: string
): Promise<Buffer> {
  const { blob } = await runner.call("files.get", { session, path });
  // Read in this process: the same bytes. Else base64 from the transport.
  return takeSessionFileBytes(blob) ?? Buffer.from(blob, "base64");
}
