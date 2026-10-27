# Approved Dispatch website

This specification supersedes the initial discovery proposal. The approved direction is study 07, shared in the task conversation for `tsk_e6883c4ec784`.

The user approved the design in message `3d6afb18-f3b2-4b4b-8eba-9fbbeffeb844` (“Looks good to me”), then confirmed the redesign approval directly to the Conductor in `85a05828-85d5-41c7-86a6-86428adccea6`. Implementation proceeds from that approval. Merge and production publishing still require the user's explicit approval: merging site changes to main triggers deployment.

## Scope and acceptance

- Implement the approved Home, Get started, Docs hub and six short guide pages in the existing Astro `apps/site` application.
- Explain work with agents broadly, including research and writing. Name Claude Code and Codex together and make existing subscriptions prominent.
- Use the actual staged-data kanban and agent-stream screenshots, intrinsic image dimensions and a readable mobile stream capture. Preserve capture provenance; never recreate product UI.
- Keep the restrained green, cyan and violet palette, product braille activity glyph, reduced-motion support and a pause control.
- Product navigation points to the homepage; Philosophy and Architecture leave the marketing navigation. Keep contributor references in Docs and preserve legacy URLs through hosting-supported redirects.
- Get started separates platforms. Mac: Applications → open → Save → Start Server → background approval if requested → Open Dispatch. Omit Mac database implementation detail. Linux: PostgreSQL 14+/psql, systemd user session, normal-user terminal installer, sudo if needed, then the printed URL.
- Show accurate release channels. As checked, Stable is v1.4.4 and task boards are Preview. Use official download destinations and recheck before publishing. Source verification of installation steps is distinct from fresh-OS runtime testing.
- Docs covers agents, project tasks, workflows, personas, reviews and setup. Remove prototype labels and editorial draft notes from public pages.
- Use real static URLs, unique metadata, canonical URLs, accessible navigation/focus, semantic headings, useful alt text, keyboard-operable copy controls and 320px reflow.
- Do not modify app runtime, deployment secrets or infrastructure, production services, VMs or unrelated retained previews.

## Delivery

Integrate from main `f1d3c4a0`, replace the discovery PR description with the implemented behavior, and run the repository's applicable mandatory checks. Validate desktop and narrow site interactions in a real browser, attach screenshots, close the browser and retain the preview for review. Obtain actual mapped owner reviews and pinned-head coverage before the allocated push/CI run. Report exact-head checks and unresolved issues; hold merge/publishing for the user.

The [product evidence ledger](product-evidence.md) is a dated audit snapshot, not a claim that every current-source feature is Stable. Installation guidance was checked against the released v1.4.4 source without executing an installer or using a VM.
