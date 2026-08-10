# zfb-example-reverse-proxy

Catch-all SSR reverse proxy example for zfb on Cloudflare Workers Static
Assets. Requests under `/proxy/...` are forwarded to `PROXY_ORIGIN`, with
method, path remainder, query string, and request body streamed to the
upstream origin.

## When to use this pattern

Use this when a zfb site needs to expose a small, trusted HTTP surface below
its own domain, such as a documentation mirror, a same-company API facade, or
an origin that must share the site's deployment boundary.

Do not use this as an open proxy. Keep the target origin fixed in
`wrangler.toml`, validate any user-controlled paths in real applications, and
avoid proxying personalized or private responses unless you also disable shared
edge caching.

## Upstream origin

`wrangler.toml` sets:

```toml
[vars]
PROXY_ORIGIN = "https://httpbingo.org"
```

`httpbingo.org` is a deterministic, httpbin-compatible origin with endpoints
that exercise the behaviors this example needs:

- `/anything/...` echoes the forwarded method, URL, query, and headers.
- `/redirect-to?url=/anything/redirect-target&status_code=302` emits a
  same-origin `Location` header for redirect rewriting.
- `/cookies/set?zfb_proxy_cookie=demo` emits `Set-Cookie`.
- `/response-headers?...` emits CSP, HSTS, and ordinary headers in one
  response.

## Route shape

The proxy route is `pages/proxy/[...path].tsx` and exports the required literal:

```tsx
export const prerender = false;
```

The catch-all route receives the path remainder after `/proxy/`. The helper
derives the upstream URL from the original request URL so percent-encoded path
segments and the query string are preserved exactly when forwarding.

## Header policy

`lib/proxy.ts` strips hop-by-hop headers on both sides:

- `connection`
- `keep-alive`
- `te`
- `trailer`
- `transfer-encoding`
- `upgrade`
- `proxy-*`

The response also strips `Set-Cookie`, `Content-Security-Policy`,
`Content-Security-Policy-Report-Only`, and `Strict-Transport-Security`.
That prevents the upstream from setting cookies for the proxy host or applying
security policies that were authored for a different origin. The trade-off is
that upstream sessions and upstream browser security policy are intentionally
not preserved by this example.

Same-origin upstream `Location` redirect targets are rewritten back under
`/proxy/`, so a redirect to `https://httpbingo.org/anything/target` becomes
`/proxy/anything/target`.

The proxy fetch uses:

```ts
fetch(upstreamRequest, { cf: { cacheEverything: true } });
```

On Cloudflare, this asks the edge cache to treat GET and HEAD upstream
responses as cacheable content beyond the default cached file types, while
still respecting origin cache headers. The cache is shared at the edge, so do
not use this setting for user-specific responses without adding a stricter
cache policy.

## Local run

In this repo:

```sh
pnpm install
pnpm dev
pnpm build
pnpm preview
```

`pnpm dev` is useful for the static index page. Because the proxy reads
Cloudflare `env.PROXY_ORIGIN`, use `pnpm preview` or direct Wrangler dev after
building when checking the SSR proxy path.

## Manual Wrangler checks

Build once, then run Wrangler from this package:

```sh
pnpm build
pnpm exec wrangler dev --port 8788
```

In another shell:

```sh
curl -i "http://127.0.0.1:8788/proxy/anything/reverse-proxy?via=zfb"
curl -i "http://127.0.0.1:8788/proxy/redirect-to?url=/anything/redirect-target&status_code=302"
curl -i "http://127.0.0.1:8788/proxy/cookies/set?zfb_proxy_cookie=demo"
curl -i "http://127.0.0.1:8788/proxy/response-headers?Content-Security-Policy=default-src%20%27self%27&Strict-Transport-Security=max-age%3D31536000&X-Demo=kept"
```

Expected checks:

- `/anything/...` returns upstream JSON without buffering the body.
- `/redirect-to...` returns `Location: /proxy/anything/redirect-target`.
- `/cookies/set...` does not return `Set-Cookie`.
- `/response-headers...` keeps `X-Demo: kept` and strips CSP and HSTS.

## Deploy

Production is served on the custom domain declared in `wrangler.toml`:

```
https://zfb-example-reverse-proxy.takazudomodular.com
```

The Worker also keeps its `*.workers.dev` host
(`zfb-example-reverse-proxy.takazudo.workers.dev`), because `wrangler.toml` sets
`workers_dev = true` and `preview_urls = true` explicitly — `preview_urls`
defaults to *match* `workers_dev`, so leaving it implicit would silently take
per-deploy preview URLs down with any later `workers_dev = false`.

No extra Cloudflare resources are required. After `pnpm build`, deploy with:

```sh
pnpm exec wrangler deploy
```

To validate `wrangler.toml` without credentials — including that the top-level
keys are not accidentally scoped into `[assets]` — use:

```sh
pnpm exec wrangler deploy --dry-run
```

A misplaced key does not fail the command; it prints
`Unexpected fields found in assets field` and is then silently ignored, so read
the output rather than just the exit code.

## Continuous deployment (GitHub Actions)

For an ordered, from-zero walkthrough of wiring this repo up to Cloudflare, see
[`docs/cloudflare-setup.md`](docs/cloudflare-setup.md).

This repo ships `.github/workflows/deploy.yml`:

- **build** runs on every push and PR — `pnpm install`, `pnpm typecheck`,
  `pnpm build`. It needs no Cloudflare credentials, so CI is green immediately.
- **deploy** runs on push to `main` and calls `wrangler deploy`. It self-skips
  until the secrets below are set, so a fresh repo never shows a red deploy.
- **smoke test** runs after a successful deploy — `pnpm smoke`, which is
  `scripts/smoke.mjs`. See below.

Add these under **Settings → Secrets and variables → Actions**:

| Secret | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | API token with Account · Workers Scripts: Edit **and** Zone · Workers Routes: Edit |
| `CLOUDFLARE_ACCOUNT_ID` | target Cloudflare account id |

No secrets or resource ids to provision; `PROXY_ORIGIN` is a public `[vars]` value in `wrangler.toml`.

### Post-deploy smoke test

`wrangler deploy` exiting 0 says the Worker uploaded — it says nothing about
whether the custom domain actually routes to it. `scripts/smoke.mjs` is the
check that confirms it, and it asserts two things against the live host:

1. `GET /` returns 200 HTML containing this site's content marker.
2. `GET /proxy/anything/reverse-proxy?via=zfb` returns JSON that demonstrably
   came from `httpbingo.org` — the echoed `method`, `args.via`, and upstream
   `url`. This is the load-bearing assertion: the static asset layer could
   never produce that body, so it proves the Worker itself ran on the domain.

Run it by hand against any host:

```sh
pnpm smoke                                    # the live custom domain
pnpm smoke http://127.0.0.1:8788              # a local `wrangler dev`
SMOKE_BASE_URL=https://... pnpm smoke
```

It sorts failures into three buckets so that CI only goes red when this repo is
genuinely broken:

| Outcome | Meaning |
| --- | --- |
| exit 0 + `::notice::` | The domain does not resolve yet, or its certificate is still provisioning. Not wired up — nothing is broken. |
| exit 0 + `::warning::` | `httpbingo.org` is down, rate-limiting, or unreachable. A 502 `Upstream fetch failed` from our own Worker lands here too — it proves the Worker *is* running on the domain; only the upstream leg failed. |
| exit 1 + `::error::` | Genuinely broken: the asset layer answered `/proxy/` instead of the Worker, `PROXY_ORIGIN` is missing from the deployment, the wrong site is on the domain, or the proxy returned a body that did not come from the upstream. Also any *unrecognised* network or TLS error — notably an expired certificate, which a live domain can only reach by breaking — and a malformed base URL. |

Only errors explicitly recognised as "not provisioned yet" or "transient" are
allowed to exit 0; anything unrecognised fails, so a new failure mode can never
silently produce a green run.

The upstream is a third-party service, so requests get a bounded retry (3
attempts with backoff) before any verdict is reached.

### Cloudflare API token permissions

The `CLOUDFLARE_API_TOKEN` repo secret is a custom token (Cloudflare dashboard →
My Profile → API Tokens → Create Custom Token) with these permissions:

| Type | Resource | Level |
| --- | --- | --- |
| Account | Workers Scripts | Edit |
| Account | Account Settings | Read |
| Zone | Workers Routes | Edit |

Set **Account Resources → Include → (your account)** and **Zone Resources →
Include → takazudomodular.com**.

**Zone · Workers Routes · Edit is required** because this repo serves production
on a custom domain (the `[[routes]]` block in `wrangler.toml`). Without it,
`wrangler deploy` still uploads the Worker successfully and then fails on the
route-creation step — so the deploy job goes red while the Worker itself is
fine. A single token can be shared across all `zfb-example-*` repos if it
carries the union of every repo's permissions.
