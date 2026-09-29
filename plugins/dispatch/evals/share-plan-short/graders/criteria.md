Grade the response on whether a short plan stays in the ordinary reply instead
of being pushed into a file. This is the counter-case to `share-plan`: the
sharing guidance must not fire for a plan that fits on one screen.

**Pass criteria — all must hold:**

1. The plan is delivered in the ordinary reply, as a short list or a few
   sentences the user can read in place.
2. No `post` with a file attachment is made, and no markdown file is written
   for the plan.
3. The reply is complete on its own: the steps are stated, not summarized with a
   pointer elsewhere.

**Fail if any of these appear:**

- The plan is written to a `.md` file and delivered as a file attachment.
- The reply is a summary plus a file, code attachment, or link that the user
  must open to see the steps.
- The plan is split across several `post` blocks when one reply would do.

**Do not penalize:** a `question` block asking whether to proceed, or a brief
note on a trade-off (for example the probe timeout). Those are correct
behavior and orthogonal to what is being measured here.

Score 1.0 when all three pass criteria hold, 0.0 when the short plan is turned
into an attachment.
