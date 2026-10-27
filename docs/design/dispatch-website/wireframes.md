# Homepage content wireframes

Companion to [the proposal](proposal.md). These are low-fidelity content hierarchy artifacts, not product screenshots or a site implementation. The user owns design approval. All routes in the artifact describe proposed future destinations.

## Review artifacts

Downloadable artifacts are attached to the task agent's root stream:

- `homepage.html`: standalone responsive wireframe with embedded CSS/logo and a separate annotation rail; open locally without a server.
- `desktop.png`: complete desktop content hierarchy at 1440 × 1000 viewport.
- `mobile.png`: complete mobile content hierarchy at 390 × 844 viewport; review annotations follow the proposed site footer.
- `dispatch-proposal-mobile-menu.png`: parent verification after opening the mobile Menu.
- `dispatch-proposal-workflow-desktop.png` and `dispatch-proposal-mobile-workflow.png`: parent verification after activating See the workflow.

The empty screenshot region is intentional. Real product captures must come from a named public release using the proposal's shotlist. No simulated application interface, testimonial or invented live activity is included.

## Desktop hierarchy

```text
┌───────────────────────────────────────────────┬─────────────────────┐
│ Dispatch      Product  Docs   [Get started]    │ REVIEW ANNOTATIONS  │
├───────────────────────────────────────────────┤ (not site content)  │
│ For developers using coding agents            │                     │
│ Keep coding-agent work moving.                │ A. Audience → value │
│ Product definition                            │ B. One real example │
│ [Get started] [See the workflow]               │ C. Workflow first   │
│ macOS/Linux · CLI/account · release paths      │ D. Bounded claims   │
├───────────────────────────────────────────────┤ E. Release labels   │
│ Authentic product screenshot PLACEHOLDER      │ F. Prerequisites    │
│ Caption explains what to look for             │ G. Mobile priority  │
├───────────────────────────────────────────────┤ H. Proposed routes  │
│ Launch in repo │ Guide work │ Review result   │ I. Brand/fidelity   │
├───────────────────────────────────────────────┤                     │
│ Available work │ Separate changes │ Evidence   │                     │
├───────────────────────────────────────────────┤                     │
│ Tasks: Preview        Scheduled jobs: Stable   │                     │
├───────────────────────────────────────────────┤                     │
│ macOS expectations    │ Linux expectations     │                     │
├───────────────────────────────────────────────┤                     │
│ Final Get started / setup requirements        │                     │
│ Footer: Docs · Architecture · About · GitHub   │                     │
└───────────────────────────────────────────────┴─────────────────────┘
```

The screenshot is subordinate to the definition/action, but large enough to explain the workspace. The annotation rail is a review aid only. Installation remains a named action instead of an implication of “Docs.”

## Mobile hierarchy

```text
┌──────────────────────────────────┐
│ Dispatch   [Get started]   Menu   │
├──────────────────────────────────┤
│ Audience                         │
│ Clear headline and definition    │
│ [Get started] [See workflow]      │
│ Platform/CLI expectations        │
│ Stable and Preview link          │
├──────────────────────────────────┤
│ Readable screenshot crop         │
│ PLACEHOLDER + caption            │
├──────────────────────────────────┤
│ 1 Launch in repository           │
│ 2 Guide the work                 │
│ 3 Review result                  │
├──────────────────────────────────┤
│ Benefits, stacked                │
│ Stable/Preview distinctions      │
├──────────────────────────────────┤
│ macOS requirements               │
│ Linux requirements               │
│ Final action + footer            │
├──────────────────────────────────┤
│ REVIEW NOTES (artifact only)     │
└──────────────────────────────────┘
```

Mobile does not hide the primary action behind Menu. Numbered workflow stays complete in a single column. Public implementation should tighten optional feature details rather than put essential workflow steps in a carousel. This artifact demonstrates relative order; it is not a final spacing/type specification.

## Validation and limits

Parent read-only Playwright verification opened the standalone HTML with `domcontentloaded`, clicked See the workflow at desktop and mobile widths, opened/closed the mobile Menu, checked visible navigation/Get started and checked no page overflow at those widths. Screenshots were captured after interactions and posted as root file attachments; the browser was closed. Child validation separately checked proposed hrefs and release/platform text.

External page routes were checked as proposed href values, not navigated as implemented pages. The wireframe's Get started links do not prove a working install flow. The current product was not installed or exercised; release-tag/source evidence is documented separately. No dev stack was started, so there are no retained local preview ports or cleanup commands for this design phase. The standalone HTML needs no running process.

Copy in the visual is condensed for space. The proposal's section 5 is the editorial source for wording; both require user review. Resolve any layout/copy variation in implementation rather than treating this artifact as approved production UI.
