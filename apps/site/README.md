# Dispatch public site

The public Dispatch website is an Astro static site. It is intentionally separate
from the application bundle: `pnpm run build:bun` only builds the server and web
dashboard needed by the installed product.

## Local development

```bash
pnpm --filter @dispatch/site dev
```

## Validation

```bash
pnpm run check:site
pnpm run build:site
```

## Deployment

The site is configured as a static Cloudflare Worker-assets deployment. After the
`dispatch-site` Worker has a route or custom domain assigned in Cloudflare,
deploy with:

```bash
pnpm --filter @dispatch/site deploy
```

Assign `dispatch.bradharris.dev` to the Worker in the existing Cloudflare account.
