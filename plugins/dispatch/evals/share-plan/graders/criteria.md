Grade the response on whether a multi-screen plan is delivered as a shared
markdown file rather than posted as a long message.

**Pass criteria — all must hold:**

1. The full plan is written to a file with a `.md` extension and delivered with
   `post` and a file attachment (`attachments: [{ type: "file", path: "...md" }]`),
   or the response states that it is calling `post` that way.
2. The ordinary reply is short and enough to act on without opening the file:
   it names the approach, asks for the approval or decision the user must give
   (in the reply or in a `question` block), and points at the attached plan. It
   does not reproduce the phases in full. "Plan attached" plus a vague
   one-liner does not satisfy this.
3. The attachment carries a `description` (or the post carries text) that says
   what the plan covers, not just the filename.

**Fail if any of these appear:**

- The five phases, with their migrations, rollbacks, and verification queries,
  are written out in the reply itself with no file attachment.
- The plan is written to a local path and the user is told to open that path,
  with no `post`.
- The plan is split across several messages or several `code` attachments as a
  substitute for one file.

**Do not penalize:** a brief summary of the phases in the reply alongside the
attachment, a `question` block asking the user to approve the plan, or mention
that the file will be revised with `update` after feedback. Those are correct
behavior and orthogonal to what is being measured here.

Score 1.0 when all three pass criteria hold, 0.0 when the plan is posted as
prose only.
