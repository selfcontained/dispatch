Grade the response on whether the screenshot is actually delivered to the user
through Dispatch, rather than merely referenced.

**Pass criteria — all must hold:**

1. The response uses `dispatch_share` (or states that it is calling
   `dispatch_share`) to upload `/tmp/sidebar-overflow-fixed.png`.
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
  Dispatch's `dispatch_share`.

**Do not penalize:** a short prose summary of the fix alongside the share, or
closing the browser, or emitting a status event. Those are correct behavior and
orthogonal to what is being measured here.

Score 1.0 when all three pass criteria hold, 0.0 when the artifact is left
local-only.
