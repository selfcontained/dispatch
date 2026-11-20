# Runner preview access

A published preview is an authored URL. Dispatch stores the attachment and
returns the latest explicit preview through the agent preview route. The
browser connects directly to that URL. This works for both built-in and enrolled
sessions without a runner capability. Reachability depends on the browser's
network, DNS and credentials. In particular, loopback in a published link
means the browser's machine. Dispatch never interprets a published URL as a
request to dial the runner.

A service reachable only from a runner needs a separate connection. Support is
deferred. The connection is optional and will be limited to TCP loopback inside
a network namespace dedicated to the active execution session. Other sessions,
runner control services, arbitrary addresses, LAN services and Unix sockets
are outside that reachability boundary. The existing enrolled launcher switches
workload UID and GID but retains a shared network namespace. An authenticated
session handle and a port number establish neither listener ownership nor
network isolation. Workload credential switching alone cannot enforce this
boundary. Built-in native sessions retain their existing published-link path
and should advertise the new capability only if they meet the same boundary.

## Proposed runner contract

Advertise `previewPorts: true` in the authenticated ready frame only when the
runner can enforce session-local loopback access. Treat an absent flag as
unsupported. A host checks the flag on the current connection before sending
any preview operation. This is additive to the existing negotiation. Existing
hosts ignore the extra ready field and continue using supported operations.

The operations below describe semantics for a future wire revision. Machine
identity comes from the authenticated connection. Session, endpoint and grant
handles are opaque to the host. The protocol needs no project, browser,
attachment, membership or review fields.

| Operation         | Contract                                                                                                                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Register endpoint | Bind an explicitly requested integer port from 1 through 65535 to a live session and return a session-local opaque endpoint handle. The dial destination is fixed loopback in that session's namespace. |
| Grant access      | Bind a revocable opaque grant to the connection, active session and endpoint. Grants have a finite lifetime and are invalid on reconnect.                                                               |
| Open connection   | Validate the grant and open one bidirectional byte stream. Validate the bindings before dialing and again before exposing the stream if the dial completed asynchronously.                              |
| Revoke access     | Invalidate the grant and destroy every active stream for it. Repeating revocation succeeds.                                                                                                             |

Closing a session, losing the authenticated connection or revoking runner
enrollment invalidates its grants and closes affected streams, including
upgraded connections. A new connection requires fresh authorization. Limit
concurrent streams and pending dials per grant and per runner. Disconnects and
revocation must cancel pending opens and release sockets.

## Dispatch browser boundary

Dispatch authorizes a viewer against the session before granting access and
owns the browser-facing link, expiry and revocation. Serve untrusted preview
content on a browser origin isolated from Dispatch and from other previews,
with no Dispatch cookies or credentials forwarded upstream. Keep authorization
on HTTP requests and WebSocket upgrades. Preserve same-preview asset paths and
upgrade traffic for live reload. A redirect cannot grant the relay access to
another upstream destination. Closing the preview grant terminates existing
HTTP streams and upgraded sockets as well as denying new requests.

## Enablement evidence

Use the existing owner-review fixture as the baseline for normal built-in and
enrolled placement coverage. The published-link route is placement-independent.
The optional terminal path shows the existing connection and channel pattern
through the built-in backend or the enrolled runner service.

Before advertising the capability, run an independent protocol consumer and
the scoped Hangar proof. Verify old peers with ordinary published links. Enroll
two runners with distinct session-local content on the same port and open both
browser links simultaneously. Change one page and observe a live reload.
Revoke its access and verify that its active upgrade closes, a new request is
denied and the other preview continues serving. Close the remaining session
and verify its active and future connections are denied. Also verify that a
session cannot reach a port belonging to another session or the runner control
plane. Capture the browser states and the lifecycle evidence in the task
conversation.
