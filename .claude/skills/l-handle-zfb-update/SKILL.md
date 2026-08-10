---
name: l-handle-zfb-update
description: >-
  Update the zfb upstream dependency (the @takazudo/zfb* packages) in this
  example (reverse-proxy) to the latest stable release, review what changed
  upstream between versions, and adapt this project's code if a change touches a
  surface it uses. Use when: (1) User says 'update zfb', 'bump zfb', 'zfb
  update', or 'handle zfb update', (2) A new zfb release is out and this
  example should track it.
user-invocable: true
argument-hint: "[target-version, e.g. 2.3.0 — omit to use latest stable]"
---

# Handle zfb Update — reverse-proxy

This is a catch-all SSR reverse proxy for zfb on Cloudflare Workers Static
Assets: requests under `/proxy/...` are forwarded to `PROXY_ORIGIN` (a `[vars]`
entry in `wrangler.toml`), streaming method, path, query, and body upstream while
stripping hop-by-hop and cookie/security headers.

Bump every `@takazudo/*` package this repo depends on to the latest stable
release (kept in lockstep on one version), review what changed upstream, and
adapt this project only where an upstream change touches a surface it actually
uses.

Upstream repo: `Takazudo/zudo-front-builder` (monorepo; npm packages live under
`packages/`). Every release has a `v<version>` tag and GitHub release notes.

## Step 0 — Preconditions

`package.json` and `pnpm-lock.yaml` must be clean (`git status --short` shows
neither). If either is dirty, stop and ask before touching them.

## Step 1 — Resolve current and target versions

```bash
CURRENT=$(node -p "require('./package.json').dependencies['@takazudo/zfb']")
TARGET=${1:-$(npm view @takazudo/zfb dist-tags.latest)}
```

- Always resolve the target from the `latest` dist-tag, never `next` — this repo
  tracks the zfb stable line. The `next` prerelease line ENDED at `1.1.0-next.1`,
  a prerelease of `1.1.0`, which has since been released and superseded; the
  `next` dist-tag still points there, so resolving from it silently pins a dead
  prerelease of an already-shipped version.
- If `CURRENT` == `TARGET`: report "already at the latest stable (<version>)" and STOP.
- If an explicit target is older than `CURRENT`, that is a downgrade — stop and
  confirm first.

## Step 2 — Review upstream changes BEFORE bumping

Enumerate versions between CURRENT (exclusive) and TARGET (inclusive) in publish
order — never sort prerelease strings lexically (`next.9` vs `next.10`):

```bash
node -e '
const vs = JSON.parse(process.argv[1]);
const cur = vs.indexOf(process.argv[2]), tgt = vs.indexOf(process.argv[3]);
if (tgt < 0) { console.error("target not found"); process.exit(1); }
if (cur >= 0 && tgt <= cur) { console.error("not newer than current"); process.exit(1); }
console.log(vs.slice(cur + 1, tgt + 1).join("\n"));
' "$(npm view @takazudo/zfb versions --json)" "$CURRENT" "$TARGET"
```

Read the release notes for EVERY enumerated version:

```bash
gh release view "v<version>" --repo Takazudo/zudo-front-builder --json body -q '.body'
```

If a release has no notes, fall back to the commit list:

```bash
gh api "repos/Takazudo/zudo-front-builder/compare/v<prev>...v<version>" \
  --jq '.commits[].commit.message' | head -40
```

**Fail closed:** if the changes cannot be reviewed at all, stop and ask — never
bump blind.

Flag anything that touches a surface this example uses:

| Upstream surface | Where this project uses it |
| --- | --- |
| `defineConfig` schema | `zfb.config.ts` — framework / adapter / tailwind settings |
| Cloudflare adapter + `getCloudflareContext()` (`env.PROXY_ORIGIN`) | `lib/proxy.ts`, `pages/proxy/[...path].tsx` |
| SSR route contract (`export const prerender = false`) | `pages/proxy/[...path].tsx` |
| Catch-all dynamic route (`[...path]`) | `pages/proxy/[...path].tsx` |
| Tailwind / CSS pipeline | `styles/global.css` |
| CLI (`zfb dev/build/preview/check`) | `package.json` scripts, `wrangler.toml` |

Rule: adapt only if this project actually uses the changed feature. Internal zfb
changes (Rust internals, docs, other frameworks) need no action — note and move on.

## Step 3 — Bump every @takazudo/* package (lockstep)

```bash
PKGS=$(TARGET="$TARGET" node -p "Object.keys(require('./package.json').dependencies).filter(n=>n.startsWith('@takazudo/')).map(n=>n+'@'+process.env.TARGET).join(' ')")
pnpm add -E $PKGS
```

- `-E` keeps the exact pin (no caret) — this repo tracks one known-good zfb version.
- All `@takazudo/*` packages must land on the SAME version.
- Commit `package.json` AND `pnpm-lock.yaml` together — CI installs with
  `pnpm install --frozen-lockfile` and fails on a stale lockfile.
- pnpm is the package manager; npm is only for reading registry metadata.

## Step 4 — Adapt project code (only if Step 2 flagged something)

Apply what the flagged notes require (config schema, renamed APIs, adapter or
`ctx` changes, island markup, etc.). Update `README.md` if commands or documented
behavior changed. If nothing was flagged, skip.

## Step 5 — Verify

```bash
rm -rf ./dist ./.zfb ./.zfb-build
pnpm build       # pages build cleanly, adapter writes dist/_worker.js + dist/.assetsignore
pnpm typecheck   # zfb check passes
```

`zfb dev` renders the static index but does not read `env.PROXY_ORIGIN`; check the
proxy path with `pnpm build` then `pnpm exec wrangler dev` and the manual Wrangler
checks in the README.

## Step 6 — Report

Summarize: versions traversed, notable upstream changes per release (one line
each), adaptations made (or "none needed"), and verification results.
