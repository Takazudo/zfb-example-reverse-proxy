# Cloudflare setup

An ordered, from-zero walkthrough that takes this repo from "never deployed" to
a live Worker at
`https://zfb-example-reverse-proxy.takazudomodular.com`.

**Read the preflight notice before trusting a green run.** The `deploy` job in
`.github/workflows/deploy.yml` self-skips whenever `CLOUDFLARE_API_TOKEN` is
unset, so a green CI run does not by itself mean anything shipped — and the
smoke test that follows self-skips too while the custom domain does not
resolve. Everything below is the first-time path; follow it in order.

The README covers what the proxy *is* (route shape, header policy, local runs)
and remains the reference for that. This document only covers getting it
deployed.

## What you do and do not have to provision

Nothing. There is no KV namespace, no D1 database, no R2 bucket, and no Worker
secret to create. The one piece of configuration the proxy needs — the upstream
origin — is a **public `[vars]` value committed in `wrangler.toml`**:

```toml
[vars]
PROXY_ORIGIN = "https://httpbingo.org"
```

`PROXY_ORIGIN` is plain configuration, not a credential. Do **not** run
`wrangler secret put PROXY_ORIGIN` — a Worker secret of the same name would
shadow the committed var and make the deployed behavior disagree with the repo.
Change it by editing `wrangler.toml` (step 3), not by setting a secret.

So the entire setup is: one API token, two GitHub Actions secrets, one push.

## 1. Create (or reuse) the Cloudflare API token

All nine `zfb-example-*` repos share **one** account-scoped token. If you have
already made it for another example site, skip to step 2 and reuse it — the
family-wide guide covers minting it once and the union of permissions it
carries:

<https://github.com/Takazudo/zfbex-tweaker/blob/main/docs/cloudflare-shared-token-and-env-setup.md>

To create one just for this repo: Cloudflare dashboard → My Profile → API
Tokens → Create Custom Token, with these permissions:

| Type | Resource | Level |
| --- | --- | --- |
| Account | Workers Scripts | Edit |
| Account | Account Settings | Read |
| Zone | Workers Routes | Edit |

Set **Account Resources → Include → (your account)** and **Zone Resources →
Include → takazudomodular.com**.

The Zone permission is not optional here. This repo serves production on the
custom domain declared in `wrangler.toml`:

```toml
[[routes]]
pattern = "zfb-example-reverse-proxy.takazudomodular.com"
custom_domain = true
```

`wrangler deploy` creates that route as the last step of a deploy. A token
without **Zone · Workers Routes · Edit** uploads the Worker successfully and
then fails on route creation, which reads as a red deploy even though the
Worker itself deployed fine — see Troubleshooting.

You also need the target **account id**, shown on the Cloudflare dashboard
account home (or via `pnpm exec wrangler whoami`).

## 2. Set the two GitHub Actions secrets

The workflow reads exactly two secrets:

| Secret | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | the token from step 1 |
| `CLOUDFLARE_ACCOUNT_ID` | the target Cloudflare account id |

From the CLI:

```sh
gh secret set CLOUDFLARE_API_TOKEN --repo Takazudo/zfb-example-reverse-proxy
gh secret set CLOUDFLARE_ACCOUNT_ID --repo Takazudo/zfb-example-reverse-proxy
```

Each command prompts for the value, so the secret never lands in your shell
history. The equivalent UI path is **Settings → Secrets and variables →
Actions**.

## 3. Point `PROXY_ORIGIN` at the intended upstream

The committed value is `https://httpbingo.org`, a deterministic
httpbin-compatible origin chosen so the example's demo requests return
predictable output. If that is what you want to demo, this step is already
done.

To proxy something else, edit `wrangler.toml`, then commit and push — the push
to `main` redeploys with the new value:

```toml
[vars]
PROXY_ORIGIN = "https://your-origin.example.com"
```

Two things to keep in mind. The origin must be a scheme-qualified absolute URL,
and it is baked into the deployment as public configuration — anyone can read
it in this repo, so it must not be a URL that is meant to stay private. Keep it
fixed here rather than deriving it from user input; this is a fixed-target
proxy, not an open one.

## 4. Trigger the first deploy

`deploy` runs on **push to `main`** only. There is no `workflow_dispatch`
trigger, so you cannot start it from the Actions "Run workflow" button. Use
either:

- **Push any commit to `main`** — the ordinary path, and the one you are
  probably already on.
- **Re-run the last `main` run** if the secrets were added after your most
  recent push, so no new commit is needed:

  ```sh
  gh run list --repo Takazudo/zfb-example-reverse-proxy --branch main --limit 1
  gh run rerun <run-id> --repo Takazudo/zfb-example-reverse-proxy
  ```

The run has two jobs. `build` (typecheck + `zfb build`) needs no credentials
and has been green all along. `deploy` then runs a preflight that skips the
deploy unless `CLOUDFLARE_API_TOKEN` is set and `wrangler.toml` holds no
`REPLACE_WITH_*` placeholder — this repo has no placeholder, so the token is
the only gate. Once it passes, the step runs `pnpm exec wrangler deploy`.

## 5. Verify the deployment

The Worker is live at:

```
https://zfb-example-reverse-proxy.takazudomodular.com
```

The deploy job runs `pnpm smoke` (`scripts/smoke.mjs`) immediately after a
successful deploy, which is the automated version of this section: it asserts
the home page carries this site's content marker and that `/proxy/` returns a
body that genuinely came from the upstream. It self-skips with a `::notice::`
while the domain does not resolve yet, so check the run log for that notice
before assuming the domain is live. You can run the same check locally:

```sh
pnpm smoke
```

To verify by hand, confirm the deploy step in the Actions run actually ran
rather than emitting a skip notice, then exercise the proxy. These are the
README's "Manual Wrangler checks" pointed at the deployed host instead of
`wrangler dev`:

```sh
BASE=https://zfb-example-reverse-proxy.takazudomodular.com
curl -i "$BASE/proxy/anything/reverse-proxy?via=zfb"
curl -i "$BASE/proxy/redirect-to?url=/anything/redirect-target&status_code=302"
curl -i "$BASE/proxy/cookies/set?zfb_proxy_cookie=demo"
curl -i "$BASE/proxy/response-headers?Content-Security-Policy=default-src%20%27self%27&Strict-Transport-Security=max-age%3D31536000&X-Demo=kept"
```

Expected, matching the header policy the README documents:

- `/` serves the static index page from the built assets.
- `/proxy/anything/...` returns upstream JSON with the forwarded method, URL,
  and query preserved.
- `/proxy/redirect-to...` returns `Location: /proxy/anything/redirect-target` —
  the same-origin target rewritten back under `/proxy/`.
- `/proxy/cookies/set...` does **not** return `Set-Cookie`.
- `/proxy/response-headers...` keeps `X-Demo: kept` and strips
  `Content-Security-Policy` and `Strict-Transport-Security`.

A stripped `Set-Cookie` and missing CSP/HSTS are the proxy working as designed,
not a broken upstream.

## Troubleshooting

**The `deploy` job was skipped.** Look for the preflight notice in the run log.
`CLOUDFLARE_API_TOKEN is not set` means step 2 did not take effect for that
run — either the secret is missing/misnamed, or it was added *after* the run
started. Re-run the `main` run (step 4). Secrets are not available to runs
triggered from forks, so a fork PR will always skip.

**`wrangler deploy` fails on authentication or authorization.** The token is
wrong, expired, or under-scoped. Confirm it carries Workers Scripts · Edit and
Account Settings · Read, that its Account Resources include the account whose
id is in `CLOUDFLARE_ACCOUNT_ID`, and that the two secrets belong to the *same*
account.

**The deploy uploads the Worker and then fails creating the route.** The token
is missing **Zone · Workers Routes · Edit** for `takazudomodular.com` (step 1).
The Worker itself deployed — only the custom-domain attach failed, so the
`*.workers.dev` host works while the custom domain does not resolve. Add the
Zone permission to the token and re-run the deploy. Do **not** "fix" this by
deleting the `[[routes]]` block from `wrangler.toml`; that would make the red
go away by dropping the custom domain entirely.

**The smoke test says the asset layer answered `/proxy/`.** The static assets
are being served but the Worker script is not running for that path. Check that
`main = "./dist/_worker.js"` still resolves after the build and that
`run_worker_first` was not flipped to something that skips the worker.

**The proxy returns upstream errors (502/504, or unexpected 4xx bodies).** The
Worker deployed fine; the upstream leg is the problem. Check that
`PROXY_ORIGIN` in `wrangler.toml` is the origin you meant, is reachable from
the public internet, and is serving the paths you request — a 404 from
`/proxy/foo` is usually the upstream's own 404 for `/foo`. Verify by hitting
the origin directly:

```sh
curl -i "https://httpbingo.org/anything/reverse-proxy?via=zfb"
```

If the origin answers but the proxy does not, redeploy — a `PROXY_ORIGIN` edit
only takes effect once the push to `main` completes a deploy.

**The deployed origin does not match `wrangler.toml`.** A Worker secret named
`PROXY_ORIGIN` overrides the committed `[vars]` value. Check with
`pnpm exec wrangler secret list` and delete it if present; this project expects
the var, not a secret.
