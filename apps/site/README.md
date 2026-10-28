# Dispatch public site

The public Dispatch website is an Astro static site, separate from the installed
application bundle. It uses native HTML controls and a small amount of browser
JavaScript for the home-page motion toggle and install-command copy button.

## Local development and validation

```bash
pnpm --filter @dispatch/site dev
pnpm run check:site
pnpm run build:site
```

The public routes are `/`, `/start`, `/docs`, and six `/docs/<guide>` pages.
Guide content lives in `src/content/guides.ts`. `/docs#install` retains a direct
setup link. The site includes canonical/social metadata, a static sitemap,
`robots.txt`, and a genuine 404 page.

## Product screenshot provenance

The three files in `public/captures/` are lossless WebP encodings of real Dispatch
screenshots captured on 2026-10-27 from development build
`d2c9dd6de938324f319230722f827d60cfc39a10`, using the Midnight theme and staged
Fieldnotes project data. No interface pixels were edited or recreated.

| Asset                      | Original capture                                                                | Intrinsic dimensions |
| -------------------------- | ------------------------------------------------------------------------------- | -------------------- |
| `kanban-board.webp`        | `kanban-board.png`                                                              | 1920 × 800           |
| `agent-stream-focus.webp`  | `agent-stream-focus.png` (actual desktop main element, without project sidebar) | 960 × 1144           |
| `agent-stream-mobile.webp` | `agent-stream-mobile.png` (real mobile viewport, scrolled to summary/question)  | 390 × 900            |

The board contains 11 staged tasks and staged Starting, Waiting, and Idle agent
states. The stream contains a staged research exchange, uploaded Markdown
synthesis, and open question. Captures came from an isolated database with inert
agent runtimes; they do **not** demonstrate live provider work, completed reviews,
or release certification. Short visible captions retain that distinction. The
mobile source is a separate capture, not a desktop crop. Lossless compression
preserves all pixels and original dimensions; all three assets together are
approximately 220 KiB. Original capture inputs were supplied with the approved
implementation brief under `/tmp/dispatch-site-captures/`.

## Release information

The approved installation copy targets Stable v1.4.4, macOS 13+ on Apple Silicon,
and Linux with PostgreSQL 14+ and systemd. Task boards and their column triggers
are identified as Preview. Recheck release links and channel facts before
publishing a later release. Installation instructions were checked against the
approved study and source, not a fresh installation on either platform.

## Deployment

The site is a static Cloudflare Worker-assets deployment. Its Wrangler
configuration is the source of truth for the `dispatch.berad.dev` custom domain.
Legacy marketing routes are mapped in `public/_redirects`; they are not duplicate
Astro pages. Cloudflare processes those redirects before static asset lookup.

Deploy manually with:

```bash
pnpm --filter @dispatch/site run deploy
```

Pushes to `main` that affect the site run the same deployment through GitHub
Actions. That workflow needs repository secrets named `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID`. The token needs permission to edit Workers and the
`berad.dev` zone. Building or previewing locally does not deploy the site.
