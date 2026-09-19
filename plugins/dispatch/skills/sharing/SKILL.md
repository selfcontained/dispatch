---
name: sharing
description: Give the user a file, screenshot, log, or snippet they can actually open. Use whenever you produce an artifact worth seeing — writing it to disk and pasting the path does not surface it in Dispatch.
---

# Sharing artifacts with the user

When you produce something the user should see — a screenshot, a diff, a
generated config, a log excerpt, a report — hand it over with `post` and a file
attachment. The file is uploaded into the Dispatch session, where it renders
inline in the stream and stays attached to the conversation.

**The failure this prevents:** writing the file to `/tmp` and pasting the path.
That path is meaningless to a user reading the session in a browser, on a phone,
or on a different machine from the one the agent is running on. A local path is
not a deliverable.

## How to post one

**A file that already exists** — the common case:

```
post  text: "Login flow after the redirect fix",
      attachments: [{ type: "file", path: "/tmp/login-flow.png",
                      description: "Login flow after the redirect fix" }]
```

`path` is absolute and on the machine you are running on. One post can carry
several attachments — a before/after pair goes in one block, not two.

**Text you are generating right now** — write it to a temp file with a real
extension and attach that. The extension drives syntax highlighting and how the
artifact renders, so `migration-plan.md`, not `migration-plan`. A short snippet
that is not worth a file can go as `{ type: "code", code, language, path }`
instead, where `path` is a caption saying where it came from.

Supported: images (`png`, `jpg`, `jpeg`, `gif`, `webp`), video (`mp4`), documents
(`pdf`), and text (`txt`, `md`, `json`, `yaml`, `ts`, `py`, `go`, `rs`, `sh`,
`sql`, and similar).

## Updating instead of duplicating

`post` returns the block's `id`. When you regenerate the artifact — a report
that gets refined, a screenshot retaken after a fix — revise that block with
`update` and new attachments rather than posting again:

```
update  id: "<id from the first post>",
        text: "Report — second pass",
        attachments: [{ type: "file", path: "/tmp/report.md" }]
```

`attachments` on `update` replaces the whole list, so include everything the
block should still carry. A file you already uploaded can be re-attached by
its `fileName` instead of a `path`. Five near-identical uploads make the
session harder to read, not more thorough; but when the second version is a
different deliverable — a new flow, not a retake — a new post is right.

## Managing what you've shared

```
list_media    — metadata for this agent's shared files, including filePath
delete_media  fileName — permanently removes the file and its record
```

`list_media` returns metadata only; read the content through `filePath`
with normal file tools.

Pass `ownerAgentId` to list what your parent or one of your direct children has
shared instead — same shape, read-only, and the `filePath` points into their
directory. A child's posts already land in the parent's stream, so a child that
has posted its screenshots does not need to message you the paths, and you do
not need to re-post them for the user. `list_pins` takes `ownerAgentId` the
same way, so a child can read the dev-stack URL or PR link you pinned rather
than being told.

## Write a description that earns the click

The description is the label the user sees before deciding to open it. Say what
the artifact _shows_, not what it is:

- Weak: "screenshot.png"
- Strong: "Sidebar collapsed — the overflow menu no longer clips at 375px"

## When to share

- **Any screenshot from a browser or simulator run.** Never leave one local-only.
- **Before/after pairs** when you have fixed something visual — two attachments
  beat a paragraph describing the difference.
- **Long output** you would otherwise paste into chat: test failures, generated
  files, query results. Attached, it stays readable and does not bury your summary.
- **Anything the user might want to forward.** A path cannot be forwarded.

Keep the prose summary in your reply and put the bulk in the artifact. The reply
says what happened; the file is the evidence.
