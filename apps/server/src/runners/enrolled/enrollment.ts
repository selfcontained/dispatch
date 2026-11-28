import type { TLSSocket } from "node:tls";
import type {
  EnrollmentRequest,
  EnrollmentReply,
} from "@dispatch/runner-protocol";
import { wireFrames } from "@dispatch/runner-client/v1/node";

/** Each TLS bootstrap connection exchanges one pairing request and reply. */
export function receiveEnrollmentRequest(
  socket: TLSSocket,
  receive: (
    request: EnrollmentRequest,
    reply: (frame: EnrollmentReply) => void
  ) => void
) {
  let used = false;
  const send = wireFrames<EnrollmentRequest, EnrollmentReply>(
    socket,
    (request) => {
      if (used) return socket.destroy();
      used = true;
      receive(request, (frame) => {
        try {
          send(frame);
        } catch {
          /* The requester disconnected. */
        }
        socket.end();
      });
    }
  );
}
