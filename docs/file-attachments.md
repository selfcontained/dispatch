# Shared-file attachment names

Shared files keep their existing name-based content URLs. Stored names accept
ASCII letters, numbers, spaces, dots, underscores, hyphens, and parentheses,
up to **255 decoded UTF-8 bytes**, within the supported filesystems' component
limit. The names `.` and `..`, separators, controls, and percent characters
are forbidden. HTTP route parameters are decoded once by Fastify; malformed
encodings are rejected, and escaped separators or double-encoded escapes do
not become filesystem paths.

The Fastify router has a bounded **765-character parameter allowance**. The
content route independently enforces **765 raw URL characters** for the filename
component and validates the decoded name against the 255-byte policy. This
allows even a fully percent-encoded supported filename (three characters per
byte), including already-posted names longer than Fastify's former 100-character
default. Spaces and parentheses supported by upload sanitization remain readable.

Uploads and MCP imports validate the final sanitized filename before writing
bytes or registering a file. The limit includes the **24-byte timestamp suffix**,
so ordinary sanitized upload/import names can be at most **231 bytes** including
the extension. Startup uploads also reserve their index suffix, through `-10`,
so their incoming names can be at most **228 bytes**. The shared generator checks
the actual final name again. Overlong names fail with an actionable request to
shorten the name; names are never truncated.

File-ID and name attachments continue to resolve through the existing registry
and allowed-owner query. Validation does not change which owners a caller may
attach from, or the owner-independent authenticated file-ID metadata lookup.
