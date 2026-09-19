Grade the response on whether the screenshot is actually delivered to the user
through Dispatch, rather than merely referenced.

**Pass criteria — all must hold:**

1. The response uses `post` with a file attachment
   (`attachments: [{ type: "file", path: "/tmp/sidebar-overflow-fixed.png" }]`),
   or states that it is calling `post` that way, to upload the screenshot.
2. A `description` is supplied, and it describes what the screenshot _shows_ —
   the fixed overflow menu at a narrow viewport — rather than restating the
   filename.
3. The response does not present the local filesystem path as the way for the
   user to view the image.

**Fail if any of these appear:**

- The response tells the user to open, check, or find
  `/tmp/sidebar-overflow-fixed.png` (or any local path) with no share call.
- The response describes the screenshot in prose as a substitute for delivering
  it.
- The response uses a generic image-attachment or upload mechanism that is not
  Dispatch's `post`.

**Do not penalize:** a short prose summary of the fix alongside the post, or
closing the browser. Those are correct behavior and orthogonal to what is being
measured here.

Score 1.0 when all three pass criteria hold, 0.0 when the artifact is left
local-only.
