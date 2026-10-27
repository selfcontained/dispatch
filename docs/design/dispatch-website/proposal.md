# Dispatch website: content strategy and information architecture

Task: `tsk_e6883c4ec784` · Proposal v1 · 2026-10-26 America/Denver (audit 2026-10-27 UTC)

**Decision requested:** approve the narrative, navigation and content priorities before authorizing site implementation. This document is a design proposal, not approved public copy or a release announcement. No production site files or deployment settings change in this phase.

## 1. Recommendation and audience

Lead with a concrete job: **direct coding-agent work in your own environment, see what needs you, and review the result.** Name the product as a **local-first workspace for coding agents**. Use “control plane” in technical explanations, after the visitor understands the workflow.

**Provisional audience assumption:** individual developers already using coding agents, including developers who coordinate several agents on one project. The existing individual-vs-team question is pending with the Conductor. This assumption must be confirmed or revised before public copy is approved. “Multiple agents” is not evidence of multi-user team accounts, permissions or shared organizational administration.

The problem is practical: a coding task accumulates a branch, questions, screenshots, links and review findings while the developer moves between sessions. Dispatch keeps the agent's work and the record needed to direct it available in a browser workspace.

The value hierarchy is:

1. Run and follow coding-agent work in a repository.
2. Answer questions and inspect evidence without reconstructing a transcript.
3. Review changes with worktrees, diffs and structured findings.
4. Reuse a useful practice through tasks, personas, templates and scheduled jobs.
5. Understand local setup, provider dependencies and execution boundaries before installing.

This is a recommendation grounded in available capabilities, not validated audience research. The audit found content and journey gaps; it did not measure visitor conversion or run user interviews.

### Positioning choices and tradeoffs

| Choice           | Recommendation                                                                                                      | Tradeoff                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Category         | Local-first workspace for coding agents                                                                             | More understandable than “control plane”; the first paragraph must clarify that it runs existing coding-agent tools.          |
| Lead benefit     | Keep agent work visible and actionable across sessions                                                              | Narrower and more credible than an autonomous software-team promise.                                                          |
| Audience         | Developer directing agents, provisionally                                                                           | A team-first narrative would require evidence for human access, identity and administration plus a different onboarding path. |
| Primary action   | **Get started** → `/start`                                                                                          | One destination accommodates different platforms and release channels; avoids an ambiguous download button.                   |
| Secondary action | **See the workflow** → homepage `#workflow`                                                                         | Shows the product before asking visitors to read implementation details.                                                      |
| Differentiators  | Durable host processes, isolated Git worktrees, structured questions/artifacts/reviews, reusable task/job practices | Explain observable behavior; make no competitor, productivity or reliability benchmark claims.                                |
| Expectations     | Local machine/server stays available; CLI/account setup required; Linux database/service prerequisites              | Honest setup friction belongs near the CTA, not after a download.                                                             |

A meaningful alternative exists only if the user chooses teams as the primary buyer: lead with “A shared workspace for engineering work with agents,” then demonstrate the actual human sharing/access model and onboarding. Do not use that alternative merely because agents collaborate with each other. Keep the recommended narrative until that positioning fork is resolved.

## 2. Audit: current pages and paths

Audit basis: checkout `a60a0ac6dfa9b686e842c0b11d9f19205694ab41`; all six content routes inspected in source and rendered at `https://dispatch.berad.dev` in read-only Playwright. Homepage → Docs navigation was exercised at desktop width; the mobile Menu was opened at 390 × 844. The four deeper editorial routes returned HTTP 200. Images on the homepage loaded; no horizontal overflow was observed in that mobile viewport. This is a bounded content audit, not an exhaustive link, accessibility or device test.

| Current route/source under `apps/site/src/pages/` | What it does today                                                                                                                                                                          | Disposition and reason                                                                                                                                                                                                  |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/` · `index.astro`                               | Hero “Software engineering is collaborative. AI should be, too.”; four collaboration scenes; durable objects; evening handoff; local environment; capabilities; origin story; reading links | **Rewrite.** Keep durable execution, worktrees and evidence as proof. Replace repeated philosophy with a concrete workflow and explicit setup CTA. The current first action goes to more explanation, not installation. |
| `/collaboration` · `collaboration.astro`          | Shared-workspace diagram, persistence explanation, bug investigation, workflow philosophy                                                                                                   | **Merge/rewrite into `/product`.** Keep one realistic scenario. Bound what survives and explain worktrees. Move the workflow-engine argument into About; it is not an introductory user task.                           |
| `/philosophy` · `philosophy.astro`                | Capabilities vs workflows and shared workspaces                                                                                                                                             | **Merge into `/about`.** Keep a concise rationale after the product explanation; remove duplicated claims rather than copy the whole essay.                                                                             |
| `/principles` · `principles.astro`                | Eight provisional convictions                                                                                                                                                               | **Merge into `/about#principles`.** Preserve human responsibility and visible evidence; shorten overlapping orchestration/capability statements. Keep labelled beliefs separate from product capability claims.         |
| `/architecture` · `architecture.astro`            | Browser/server/agent host/PostgreSQL diagram, worktrees, MCP, execution model                                                                                                               | **Keep and revise at `/architecture`.** Valuable technical proof and contributor entry; move out of primary marketing navigation. Add runtime boundaries and verified references.                                       |
| `/docs` · `docs.astro`                            | Installation, CLI recommendations, three concepts, README/architecture links                                                                                                                | **Split by purpose.** `/start` owns platform choice, channel and first successful agent; `/docs` becomes a usage hub. Keep `/docs` working and preserve discoverability for old install links.                          |
| `/404` · `404.astro`                              | Generic return-home action                                                                                                                                                                  | **Keep, improve recovery.** Add Get started, Docs and Product links. Do not redirect all unknown routes to home.                                                                                                        |

### Navigation, CTA and metadata findings

`layouts/Base.astro` places How it works, Ideas, Architecture and Docs beside GitHub. There is no named download or Get started action. Mobile adds Principles, creating a different information structure. The footer repeats the GitHub destination. The homepage's last paragraph finally links “run Dispatch locally” to Docs, after extensive conceptual reading.

Keep a compact header, recognizable logo, dark surfaces, thin rules and cyan emphasis. Replace abstract navigation with task labels. Get started should be visible on every viewport. GitHub remains easy to find in the footer, Docs and the contributor route; it does not need to compete with installation twice in the hero.

Source and browser both show the same default description on Philosophy, Principles and Architecture. `Base.astro` supplies title and description but no canonical or social preview metadata. Each proposed page needs a unique title/description and a canonical URL. Do not interpret these observations as measured SEO performance.

### Image and claim audit

| Existing asset in `apps/site/public/`   | Evidence/role                                                                                   | Decision                                                                                                                                                                                            |
| --------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `brand-full-logo.svg`, `brand-icon.svg` | Existing identity; header plus a second large hero logo                                         | **Keep.** Use one clear header wordmark; spend hero space on value and product evidence.                                                                                                            |
| `agent-conversation.png`                | A cropped thread under Pins/Media/Reviews/Messages tabs; labels describe a frontend UX reviewer | **Replace capture, keep question-in-context idea.** It is too narrow to explain the whole workflow and depicts a drawer structure different from current `drawer.tsx`.                              |
| `shared-pinned-context.png`             | Pins tab with staging URL, file path and review focus; staging URL is loopback                  | **Replace.** Current source uses Inbox. Capture a real linked artifact/input state from the chosen release, with sanitized sample URLs and no implication that loopback links work on every device. |
| `reviewer-in-progress.png`              | Child reviewer card in an expanded parent                                                       | **Recapture.** A useful supporting detail on Product, but activity alone does not prove a completed review. Pair with an actual finding/result.                                                     |
| `review-feedback-items.png`             | Open/fixed feedback rows with files and lines                                                   | **Recapture and retain concept.** Show a real actionable finding in context, not a status-only crop. Include accessible text for its meaning.                                                       |
| `dispatch-dashboard.png`                | Large empty main pane, two agent rows; not used on current homepage                             | **Remove from planned public asset set.** It gives little evidence of the workflow; archive the original separately if needed.                                                                      |

Source comparison: current `apps/web/src/components/app/drawer.tsx` labels an Inbox; old site images show separate Pins/Media/Reviews/Messages. This establishes a source/image mismatch, not the exact version in which each screenshot became outdated. Do not fabricate new product UI to bridge that gap.

Claims to correct wherever reused:

- “Team,” “everyone,” “future teammate,” and “the team can find both” imply an access model the site never explains. Use developer/agent language until team behavior is confirmed.
- “The agent is still running” after an evening away is conditional on the host, process, provider and permissions. Say browser disconnects and Dispatch server restarts do not themselves terminate the durable host; do not imply survival of host shutdown or every failure.
- A managed worktree separates a working directory and branch. It does not sandbox credentials or make concurrent edits impossible.
- Local-first describes where Dispatch runs and persists state. Coding-agent providers may receive prompts/code; it is not a claim that all data stays on-device or works offline.
- “Newest release” and “Stable by default” need a current channel-aware destination. The release ledger must determine availability, not stale introductory prose. Verified now: Stable v1.4.4 is promoted; Preview v1.5.4 is newer. The old pre-Stable guidance should be replaced.
- An agent review is evidence to inspect; no public copy should imply approval automatically merges or guarantees correctness.

## 3. Product evidence and publication gates

Read the companion [product evidence ledger](product-evidence.md) before approving feature claims. It separates observed source, tagged Preview evidence, Stable availability and unresolved runtime verification. The website should describe the version the visitor can actually install. A current branch feature is not automatically released. As audited: Stable v1.4.4 includes durable agents, worktrees, structured streams/Inbox, reviews, files/Brain, templates and jobs, and Claude Code/Codex/OpenCode integrations. Task boards and column triggers are released in Preview v1.5.4, not Stable. Native Mac installation targets macOS 13+ on Apple Silicon; the Linux service path requires PostgreSQL 14+ and systemd. These findings replace the initial unknown release assumptions; recheck them before publication.

Use this vocabulary consistently:

| Term        | Public meaning                                                                                                       |
| ----------- | -------------------------------------------------------------------------------------------------------------------- |
| Agent       | A coding-agent session running against a chosen repository/environment.                                              |
| Stream      | The record for an agent: replies, inputs, links, files and reviews.                                                  |
| Worktree    | A separate Git checkout/branch for a piece of work.                                                                  |
| Review      | Findings tied to work, with an explicit status and response.                                                         |
| Task        | Project work tracked on a board, with optional configured launch triggers.                                           |
| Job         | Recurring or on-demand agent work with structured outcomes.                                                          |
| Local-first | Dispatch runs and stores its workspace on your machine/server; providers remain external dependencies as configured. |

Reserve Brain, MCP, ACP, personas and service-manager vocabulary for relevant docs or short definitions. Do not make visitors learn the internal noun list to understand the homepage.

## 4. Proposed sitemap and navigation

Primary desktop navigation: **Product · Docs · Get started**. Logo → home. Mobile: logo, visible Get started, Menu for Product and Docs. Footer: Product, Get started, Docs, Architecture, About, GitHub and release notes. The information structure is identical across viewports.

| Proposed route                                                                  | Purpose and primary next action                          | Content boundary                                                                                                                                                              |
| ------------------------------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`                                                                             | Understand fit in one scan; Get started or see workflow  | Concise value, real evidence, three-step workflow, setup expectations.                                                                                                        |
| `/product`                                                                      | Evaluate a realistic end-to-end task; Get started        | Durable agents, worktrees, inputs/evidence/reviews; tasks/jobs as deeper extensions. No architecture lecture.                                                                 |
| `/start`                                                                        | Choose platform/channel and reach first successful agent | Download/install paths, dependencies, CLI authentication, first-run login, repo selection and first result.                                                                   |
| `/docs`                                                                         | Find usage help by task                                  | Start an agent; worktrees; answer inputs/inbox; files; review; tasks; jobs/templates; troubleshooting. Link to in-app help without requiring installation to read essentials. |
| `/docs/agents`, `/docs/worktrees`, `/docs/reviews`, `/docs/tasks`, `/docs/jobs` | Focused usage guidance as follow-up scope permits        | Step-by-step tasks, prerequisites, expected result, recovery. A linked section in `/docs` is acceptable for initial scope; do not ship empty pages.                           |
| `/architecture`                                                                 | Technical evaluation and contributor orientation         | Process/data diagram, persistence boundaries, tools and code links.                                                                                                           |
| `/about` and `#principles`                                                      | Explain engineering rationale                            | Concise philosophy and provisional principles, separated from capability claims.                                                                                              |

### Journeys to support

| Visitor                         | Path                                                       | Success signal                                                                                    |
| ------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| First-time developer            | Home → See workflow → Get started → platform → first agent | Can identify what runs locally, what they supply and the next action without opening source docs. |
| Returning installer/updater     | Header Get started → platform/channel/update guidance      | Finds a supported artifact/instructions and understands Preview vs Stable.                        |
| User with a blocked task        | Docs → answer input/review/worktree troubleshooting        | Finds a concrete action and expected state; no detour through marketing.                          |
| Technical evaluator/contributor | Footer Architecture → source/contributor material          | Can inspect persistence and execution boundaries without confusing them with setup requirements.  |
| Mobile visitor                  | Visible Get started or Menu → Docs                         | Platform/setup information and useful workflow remain readable; no desktop-only navigation.       |

### Existing-link preservation plan

- `/` stays home. `/architecture` stays at its existing route.
- `/collaboration` → permanent redirect to `/product` after equivalent material exists.
- `/philosophy` → `/about`; `/principles` → `/about#principles`. Use a static redirect mechanism verified on the actual hosting configuration; test fragment handling and avoid redirect chains.
- `/docs` remains a live usage hub, with a prominent installation link and retained `#install` compatibility section linking to `/start`. Preserve known heading anchors where feasible; inventory inbound anchors before implementation. No blind redirect of all Docs traffic to setup.
- Normalize slash variants consistently with Astro/hosting behavior and set one canonical URL per page. Do not change the domain in this task.
- Unknown routes remain a genuine 404 with useful next paths. Test old URLs and all nav/CTA destinations in the later implementation PR.

## 5. Annotated homepage draft

The following is representative polished copy, gated by audience/release confirmation. Annotation is not public copy. The visual wireframes are companion artifacts; screenshot areas are deliberately placeholders.

### 01 · Hero: identify the job and next step

**Eyebrow:** For developers using coding agents

# Keep coding-agent work moving.

Run coding agents in your own environment. Follow their work, answer questions, and review the results in one browser workspace.

**Primary:** Get started → `/start`  
**Secondary:** See the workflow → `#workflow`

macOS and Linux. Bring your coding-agent CLI and account.

**Annotation:** Keep product category in the page title/description and first screen. Do not insert a manifesto before the definition. Add a concise current release/channel label linked to `/start#releases` only after release verification; “release channel checked at install” in the wireframe is an editorial reminder, not approved customer-facing text.

### 02 · Show real work

**Heading:** The work, and the evidence behind it.

**Caption:** One coding task, its agent stream, and the evidence needed to review it.

Here “task” means the piece of work. A Stable screenshot must not imply that the Preview task board is available on Stable.

**Annotation:** Use a fresh, labelled screenshot from the selected public release. Desktop shows enough context to connect agent, repository, input and artifact. Mobile uses an intentional crop plus text; do not shrink a whole desktop to unreadable text. Include a link to the longer Product walkthrough. No invented product UI or testimonial.

### 03 · Workflow (`#workflow`)

## From a task to a result you can inspect.

**1. Launch in your repository.** Choose a coding agent and give it the task. Use a managed Git worktree to keep its changes in a separate checkout and branch.

**2. Guide the work.** Follow the agent's stream. Answer a question, add context, and open the files or links it shares.

**3. Review the result.** Inspect the changes and ask for a review. Keep findings and responses connected to the work, then decide what is ready.

**Link:** Explore the workflow → `/product`

**Annotation:** A concrete sequence explains the relationship among capabilities. It is an example, not a mandatory workflow or a claim of automatic completion/merge.

### 04 · Benefits with bounded proof

## Return to the work with its context intact.

**Keep work available.** Agents run in host processes independent of your browser and the Dispatch server. Closing a tab or restarting Dispatch does not itself stop the agent. The host machine still needs to stay running.

**Keep changes separate.** Managed worktrees give an agent its own checkout and branch, so you can keep your working directory for your own work. Worktrees are not a security sandbox.

**Keep decisions near evidence.** Questions, shared files, links and review findings stay in the stream, so the next decision has a concrete record behind it.

**Annotation:** These three claims need evidence beside them, not three decorative icons. Use short product crops or links to Product examples. Do not promise unlimited persistence, no conflicts, or autonomous correctness.

### 05 · Extend a useful practice

## Give repeatable work a place to live.

Use templates and scheduled jobs for recurring work with a clear outcome.

**Preview: project task boards.** Track work on a project board and configure a column to launch an agent when a task enters it. Read Preview release notes before choosing that channel.

**Link:** Tasks and automation → `/docs#tasks-and-jobs`

**Annotation:** Include only features verified for the promoted public release. If unreleased, remove this section from launch copy or label it clearly as upcoming in release notes; do not put an “available” feature screenshot behind a disclaimer elsewhere. Latest checklist/inbox work is outside this proposal's promised launch set.

### 06 · Setup and fit

## Runs where your repositories live.

Dispatch runs on macOS and Linux. You supply a supported coding-agent CLI and its account; Dispatch supplies the browser workspace around the work.

**macOS:** Install the Dispatch app on an Apple Silicon Mac running macOS 13 or later. PostgreSQL is bundled with the app. Choose Stable or opt into Preview.

**Linux:** Install PostgreSQL 14+ first. The documented installer service path uses systemd. The installer sets up Dispatch and a user service; the setup guide explains permissions and first-run steps.

**Fit note:** Your coding agent's provider and permissions still apply. Local-first does not mean every model runs on your device.

**Primary:** Get started → `/start`  
**Secondary:** Read setup requirements → `/start#requirements`

**Annotation:** Do not automatically run an installer or auto-download based on user agent. Keep both platform choices visible. “macOS and Linux” is not a Windows support claim. Native Mac minimum/version architecture is verified in the evidence ledger; the Linux distribution support policy and standalone artifact contents still need release-owner confirmation.

## 6. Secondary-page outlines and representative copy

### Product · “Follow a piece of work from launch to review”

Open: “A task has more than a prompt. It has a repository, changes, questions and evidence. Dispatch keeps those pieces connected while you direct the agent.”

Sections: (1) launch against a repository and optional worktree; (2) follow status and answer one real input; (3) inspect a screenshot/file and change; (4) request review, address one finding and show its resolution; (5) branch to tasks, templates and jobs; (6) explain runtime/provider boundaries and link setup. Each section pairs one concrete behavior with a release-labelled capture. End with Get started. Keep philosophy in an About link, not another long capabilities essay.

### Get started · “Install Dispatch and start your first agent”

Open: “Choose the machine that will run your agents. Check its requirements, install Dispatch, and connect a coding-agent CLI before starting work.”

Order:

1. Always-visible macOS/Linux links to sections, not a hidden tab that conceals prerequisites.
2. Requirements table: supported OS/architecture, database/service expectations, CLI install/auth, Git/repository access, host availability and permissions. Separate installed-product requirements from contributor requirements (Node/pnpm/Docker).
3. Current release/channel module: dated version, Preview/Stable meaning, direct platform-matched official release assets, release notes and checksums where actually published. Explain absence of Stable if none is promoted. Never invent a download URL or show a disabled Stable button without explanation.
4. macOS: ZIP → unzip → Applications → launch → first-run setup; explain signed/notarized status only after verifying release evidence. Linux: PostgreSQL/service prerequisite → inspect installer documentation → copy exact channel-aware command → open printed URL. Commands must be tested by release owners in the follow-up; no execution in this phase.
5. First agent: authenticate supported CLI → choose repository → choose worktree/access settings → give a bounded task → see stream → answer input/open result. Expected outcome: a readable agent stream with a result or a clearly explained setup error.
6. Returning users: update/channel guide, current 0.x compatibility warning after release-owner verification, troubleshooting and source install link. Source development setup is a separate path.

**CTA copy examples:** “Download for macOS [verified architecture]”; “Linux install instructions”; “Read release notes.” Bracketed editorial values must be replaced or omitted before publication.

### Docs · “Use Dispatch”

Open: “Find the next step for the work in front of you.”

Group by task: Start and resume agents / Keep changes separate / Answer questions and find shared evidence / Review changes / Track project tasks / Schedule recurring work / Configure tools and providers / Troubleshoot setup and updates. Add a clearly labelled Get started entry above the groups. Publish essentials on the public site; the in-app Docs pane remains a contextual route for installed users. Derive content from current in-app docs instead of maintaining contradictory instructions. Decide the canonical documentation source before implementation.

### Architecture · “How Dispatch keeps work available”

Use a small diagram: browser → Dispatch server → durable agent hosts; persisted workspace data → PostgreSQL. Explain browser independence, server independence, host failure boundaries, worktree semantics and provider/tool trust. Link to actual lifecycle, API and contribution docs. Separate source-development commands from product installation.

### About · “Why Dispatch is built this way”

Keep the origin in one paragraph; group principles under human judgment, visible evidence and durable context. Label them engineering beliefs, not guarantees. Link to a working Product example for each major principle. One page replaces two overlapping essays.

## 7. Visual content hierarchy and asset plan

Companion desktop/mobile wireframes retain the existing black/cyan identity and rule-based sections. They show content order and density, not a finished visual system or product simulation. Annotation belongs in a review rail/companion text, visibly separate from draft site copy.

Desktop priority: compact header → clear hero with two paths → one substantial authentic product capture → three-step workflow → bounded benefits → optional verified tasks/jobs → setup cards → final action. Avoid four large story cards before explaining the product.

Mobile priority: visible Get started in header → short hero → setup expectation line → readable product crop/caption → single-column numbered workflow → benefits → setup → optional deeper feature link. No carousel, hover-only information, auto-playing demo or giant stacked manifesto. The wireframe may retain the same semantic order while reducing optional content density. Test 320px width and 200% zoom during implementation.

### Fresh capture/demo shotlist

| Asset                                              | State to capture and purpose                                                                               | Publication criteria                                                                                                  |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Hero workspace (desktop + intentional mobile crop) | Real sample repo, one bounded task, selected agent stream, an input/artifact that explains the next action | Named release/build, readable labels, no empty dashboard, no secrets, local paths or private repo data.               |
| Worktree launch/result                             | Managed worktree selection and resulting branch context                                                    | Show optionality and checkout separation; never label it a sandbox.                                                   |
| Question → answer                                  | Genuine question or form, answered state, related stream context                                           | Capture both states or explain the transition; no fake live activity.                                                 |
| Evidence → review                                  | Real screenshot/file and a review finding with file/line, response and resolution                          | Reviewer outcome visible, not just “Working”; no promise that findings are always correct.                            |
| Task trigger (conditional)                         | Actual board column/configured trigger and resulting task/agent link                                       | Verify in selected release; exclude pending checklist features until released.                                        |
| Setup/platform                                     | Actual macOS first-run or Linux printed URL/service result                                                 | Match documented platform/channel; sanitize credentials and machine paths.                                            |
| Short workflow demo (optional follow-up)           | Launch → answer → inspect → review, with honest elapsed-time edits                                         | Captions/transcript, controls, reduced-motion support, no autoplay requirement; still images fully explain the story. |

Record a manifest per capture: filename, source build/tag/commit, OS/viewport, scenario, capture date, alt text, caption, redactions and reviewer. Use sample data in the product itself; do not paint plausible UI over a screenshot. Asset refresh is later implementation work, not fabricated evidence in this phase.

## 8. Accessibility, SEO and discoverability requirements

| Area               | Acceptance requirement for implementation                                                                                                                                                                                   |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Navigation         | Keyboard-reachable links, visible focus, skip link, active page state on desktop/mobile; disclosure has an accessible name and correct expanded state. Get started remains visible at narrow widths.                        |
| Reading hierarchy  | One meaningful H1 per page; H2/H3 order follows the document; explanatory text is real text, never embedded only in an image.                                                                                               |
| Contrast and state | WCAG AA text contrast; don't rely on cyan/green/yellow to convey status. Test focus, hover and code-block contrast against dark surfaces.                                                                                   |
| Reflow             | No horizontal page scrolling at 320px or 200% zoom except deliberately scrollable code; touch targets meet current accessibility guidance, with 44px preferred.                                                             |
| Images/demo        | Useful alt text/captions; empty alt for decorative duplicates; intrinsic dimensions; responsive formats; no screenshot required to discover a CTA. Motion can be paused and reduced.                                        |
| Installation       | Platform names, architecture, release channel and prerequisites precede commands/downloads. Copy controls announce success accessibly; links still work without JS.                                                         |
| Metadata           | Unique title/description; canonical absolute URL; social title/description/image; favicon; XML sitemap and robots behavior verified against static hosting. Use only accurate structured data, no invented reviews/ratings. |
| Downloads          | Header/hero/footer path to `/start`; official artifacts/version/architecture visible; no OS-only auto redirect. Release links/channel status rechecked before publishing.                                                   |
| Link continuity    | Test all old routes and known fragments, canonical slash forms, redirects, true 404 and external repository/release links.                                                                                                  |

Proposed metadata (working copy):

| Page         | Title before “· Dispatch”                 | Description                                                                                                                 |
| ------------ | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Home         | A local-first workspace for coding agents | Run coding agents in your own environment. Follow their work, answer questions and review results in one browser workspace. |
| Product      | From agent task to reviewed result        | See how Dispatch connects coding agents, worktrees, questions, shared evidence and review findings.                         |
| Start        | Install Dispatch on macOS or Linux        | Check platform requirements, choose a release and start your first coding agent in Dispatch.                                |
| Docs         | Using Dispatch                            | Find guidance for agents, worktrees, questions, shared files, reviews, tasks and scheduled jobs.                            |
| Architecture | How Dispatch keeps agent work available   | Explore Dispatch's browser interface, durable agent hosts, persisted workspace data and local execution boundaries.         |
| About        | Why Dispatch is built this way            | The engineering ideas behind Dispatch: human judgment, visible evidence and durable context.                                |

These are proposed requirements, not a certification that the current or future site passes accessibility/SEO audits. No analytics or tracking is introduced in this design phase.

## 9. Implementation handoff and gates

### P0 · Resolve facts and approve content (this proposal's next gate)

The user owns approvals for this task. The Conductor checks design criteria and coordinates the board; the user approves audience, narrative and any subsequent implementation/publishing. Confirm the verified platform/channel facts remain current, agree recommended provider wording, resolve Linux distribution policy and what team usage can honestly mean. Stable/Preview and native Mac facts are established in the evidence ledger, not left wholly unknown. Reconcile the evidence ledger with the release chosen for launch. Approve or edit homepage copy and sitemap. **No implementation or production publishing by silence.**

### P1 · Implement a bounded content/IA change (separate authorized follow-up)

Scope: `apps/site` routes/layout/metadata, route preservation, public setup and usage essentials. Keep changes out of app behavior and release machinery. Use Astro's existing structure and accessible native primitives. If an equivalent reusable component library already fits, prefer it; do not import app runtime state merely for a static marketing menu. Acceptance: all proposed navigation and CTA paths resolve; first install path is clear on mobile; all claims trace to selected release evidence; redirects/metadata tested; no placeholders or bracketed editorial text reach production.

### P2 · Capture proof and refine the visual design

Capture the selected release using the shotlist; implement responsive crops, alt text and lightweight images. Validate desktop/mobile workflow and setup navigation with Playwright, attach screenshots and close the browser. Review copy in rendered context for density and readability. Acceptance: every major claim has authentic evidence; no outdated drawer imagery; no unreadable mobile desktop screenshot.

### P3 · Verify and publish only with approval

Run repository-mandated checks appropriate to the implementation diff, `check:site` and `build:site`, route/link checks, keyboard/reflow checks and owner reviews. Recheck exact release links immediately before publication. `deploy-site.yml` deploys relevant paths merged to main; merging the implementation PR is a publishing action. Require explicit content approval and honor the release freeze before merging. This documentation-only proposal does not touch those paths.

### Open decisions / factual questions

| Question                                                                                                                                                    | Owner / consequence                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Individual developers, teams, or both?                                                                                                                      | User (approval owner). Determines hero subject, proof scenarios and whether team onboarding needs a separate path.                       |
| Which release is the public site's launch baseline? Stable v1.4.4 is promoted; Preview v1.5.4 is available as audited.                                      | Release owner. Determines status labels, downloads and feature availability.                                                             |
| Any additional supported Linux distributions/standalone artifact guarantees beyond verified macOS 13+ Apple Silicon and Linux PostgreSQL 14+/systemd setup? | Release owner. Required before final download/setup copy; do not equate build targets with support policy.                               |
| Which of supported Claude Code, Codex and OpenCode should be recommended first, and should any configuration caveats be foregrounded?                       | Runtime owner. Avoid a generic “all models” promise.                                                                                     |
| What human sharing/access model is intended for public “team” claims?                                                                                       | Product/auth owners. No inferred RBAC, tenancy, per-user workspace isolation or hosted offering.                                         |
| Which docs are canonical and can public essentials be reused from them?                                                                                     | Product/docs owner. Avoid README/site/in-app drift; assign update responsibility.                                                        |
| Who owns periodic screenshot/claim freshness?                                                                                                               | Product/content owner. Require release/build manifest and scheduled review before future launches, not an automation added by this task. |

### Proposal acceptance checklist

- [ ] Audience assumption explicitly confirmed or replaced; recommended narrative understood.
- [ ] Every current route and public image has a keep/rewrite/merge/remove decision.
- [ ] Product claims include source and release status; unresolved claims remain gated.
- [ ] Sitemap, old-link preservation and installation discovery accepted.
- [ ] Homepage copy, mobile priority and secondary outlines are concrete enough to edit.
- [ ] Desktop/mobile wireframes and authentic-asset shotlist reviewed.
- [ ] Accessibility/SEO requirements and scoped follow-up acceptance criteria agreed.
- [ ] User approves design direction before site implementation/publishing begins.

## 10. Validation record and limitations

Performed in this phase: current source inspection; read-only rendered public page inspection; desktop Docs CTA interaction; mobile menu interaction; current homepage image load checks; current source/image comparison. Screenshot evidence is attached to the task agent's root stream. Proposed wireframes are content hierarchy artifacts, not a tested installed product or a production preview.

No app feature code, production files, installer behavior or deployment configuration changed. Per the task's discovery-only scope and reserved shared heavy-work window, no app DB/dev stack, full E2E suite or production runtime was used. Application checks do not prove a content strategy; follow-up implementation must run the relevant mandatory checks. Documentation-only CI, formatting, owner review and exact head evidence are reported in the acceptance handoff, without claiming unrun checks passed.
