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

The site is a static Cloudflare Worker-assets deployment. Its Wrangler
configuration is the source of truth for the `dispatch.bradharris.dev` custom
domain; Cloudflare creates the DNS record and certificate on first deployment.

Deploy manually with:

```bash
pnpm --filter @dispatch/site deploy
```

Pushes to `main` that affect the site run the same deployment through GitHub
Actions. That workflow needs repository secrets named `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID`. The token needs permission to edit Workers and the
`bradharris.dev` zone.
