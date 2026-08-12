#!/usr/bin/env node
/**
 * Post-deploy smoke test for the live custom domain.
 *
 * A deploy can succeed while the site is still not reachable on its custom
 * domain, so `wrangler deploy` exiting 0 proves nothing about routing. This is
 * the only check that confirms the Worker is actually serving
 * zfb-example-reverse-proxy.takazudomodular.com.
 *
 * Two assertions:
 *   1. GET /            -> 200 HTML carrying this site's content marker.
 *   2. GET /proxy/...   -> JSON that demonstrably came from the upstream origin
 *                          (httpbingo), not from the static asset layer. This is
 *                          the load-bearing one: it proves the Worker script ran
 *                          on the custom domain rather than a file being served.
 *
 * EXIT POLICY — why this script exits 0 in cases that look like failures.
 * The house rule is that the repo never shows a red deploy for something that
 * is not this repo's fault, so failures are sorted into three buckets:
 *
 *   exit 0 + ::notice::   NOT WIRED UP YET. The domain does not resolve, or
 *                         resolves to Cloudflare with nothing bound, or its TLS
 *                         certificate has not been issued yet. Expected between
 *                         "config committed" and "route actually created", and
 *                         for a few minutes after the attach while the cert
 *                         provisions. Nothing is broken.
 *
 *   exit 0 + ::warning::  UPSTREAM'S FAULT. httpbingo.org is a third-party
 *                         service outside this repo's control; its outage or
 *                         rate limit must not red this CI forever. Note that a
 *                         502 "Upstream fetch failed" from our own Worker still
 *                         PROVES the Worker is running on the domain — the
 *                         attach worked, only the upstream leg is down.
 *
 *   exit 1 + ::error::    GENUINELY BROKEN. The Worker is not running (the
 *                         asset layer answered /proxy/ with HTML or a 404), it
 *                         is misconfigured (PROXY_ORIGIN missing), the site is
 *                         serving the wrong content, or the proxy returned 200
 *                         with a body that did not come from the upstream.
 *
 * SMOKE_REQUIRE_LIVE retires the FIRST bucket only. Once the custom domain is
 * confirmed live, "not reachable yet" stops being a plausible state and starts
 * being the exact regression this script exists to catch, so setting the flag
 * turns every not-live-yet condition into exit 1. It deliberately does NOT
 * touch the second bucket: httpbingo.org is a third party, and its outage is
 * never evidence that this repo's deploy is broken, flag or no flag.
 *
 * Usage:
 *   node scripts/smoke.mjs [base-url]
 *   SMOKE_BASE_URL=https://... node scripts/smoke.mjs
 *   SMOKE_REQUIRE_LIVE=1 node scripts/smoke.mjs   # no excuses for a live domain
 */

const DEFAULT_BASE_URL = "https://zfb-example-reverse-proxy.takazudomodular.com";

// Rendered by pages/index.tsx; verified against dist/index.html at build time.
const CONTENT_MARKER = "Reverse proxy under /proxy/";

// The catch-all SSR proxy route (pages/proxy/[...path].tsx -> lib/proxy.ts).
const PROXY_PATH = "/proxy/anything/reverse-proxy?via=zfb";
const UPSTREAM_HOST = "httpbingo.org";

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [2_000, 5_000];

/**
 * Network-level failures that mean "the custom domain is not live yet" rather
 * than "the site is broken". The TLS entries matter because Cloudflare issues
 * the edge certificate asynchronously after a custom domain is attached, so a
 * cert that does not yet cover this host is a pending state, not a fault.
 *
 * ENETUNREACH/EHOSTUNREACH cover the IPv6-only propagation window: when a
 * custom domain is attached, Cloudflare publishes the AAAA record before the A
 * record, and GitHub-hosted runners have no IPv6 route. For those few minutes
 * the runner resolves the host, gets only an IPv6 address, and cannot route to
 * it — indistinguishable from "not attached yet", and just as temporary.
 *
 * CERT_HAS_EXPIRED is deliberately NOT in this set: a newly issued certificate
 * is never expired, so an expiry can only mean an already-provisioned domain
 * broke. That must go red rather than be excused as pending setup.
 */
const NOT_PROVISIONED_ERROR_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
]);

/** Transient connection failures worth another attempt before judging. */
const RETRYABLE_ERROR_CODES = new Set([
  "ETIMEDOUT",
  "ECONNRESET",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
  "TimeoutError",
  "AbortError",
]);

/** Upstream congestion / outage statuses — retry, then degrade to a warning. */
const UPSTREAM_FLAKE_STATUSES = new Set([429, 502, 503, 504]);

/**
 * Cloudflare returns 530 when DNS points at the edge but no Worker is bound to
 * the hostname — i.e. the route has not been created yet.
 */
const NOT_PROVISIONED_STATUSES = new Set([530]);

const baseUrl = (process.argv[2] ?? process.env.SMOKE_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");

/**
 * Set by CI, where the custom domain is known to be attached and serving. It
 * asserts "this host is live" — so every not-live-yet excuse below becomes a
 * hard failure instead of a green skip.
 */
const REQUIRE_LIVE = /^(1|true)$/i.test((process.env.SMOKE_REQUIRE_LIVE ?? "").trim());

// Validated up front so a mistyped target fails loudly instead of falling into
// the network-error path, where it could be mistaken for "not deployed yet".
try {
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`unsupported protocol "${parsed.protocol}"`);
  }
} catch (err) {
  console.log(`::error::Invalid smoke-test base URL ${JSON.stringify(baseUrl)}: ${err.message}`);
  process.exit(1);
}

const notice = (message) => console.log(`::notice::${message}`);
const warning = (message) => console.log(`::warning::${message}`);
const error = (message) => console.log(`::error::${message}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Every identifying code reachable from `err`, in discovery order.
 *
 * `fetch` buries the real reason: the thrown TypeError carries the cause, and
 * when Happy Eyeballs tries several addresses the cause is an AggregateError
 * whose own `code` is undefined — the per-address failures live in `.errors[]`.
 * A `.cause`-only walk therefore reports UNKNOWN for exactly the case this
 * script most needs to recognise (ENETUNREACH from an IPv6-only DNS answer on
 * an IPv4-only runner), and UNKNOWN is a hard failure. So walk the whole graph.
 *
 * `name` is collected too because AbortSignal.timeout rejects with a
 * DOMException that has a name (TimeoutError) and no code.
 */
function errorCodes(err) {
  const codes = [];
  const names = [];
  const seen = new Set();

  const visit = (node) => {
    if (node === null || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (typeof node.code === "string") codes.push(node.code);
    if (typeof node.name === "string") names.push(node.name);
    if (Array.isArray(node.errors)) node.errors.forEach(visit);
    visit(node.cause);
  };

  visit(err);
  // `code` first: it is the specific reason, where `name` is usually just the
  // constructor (TypeError, Error) and only carries meaning for TimeoutError.
  return { codes, names, all: [...codes, ...names] };
}

const matchesAny = (err, codeSet) => errorCodes(err).all.some((code) => codeSet.has(code));

/** The codes worth printing — constructor names only when nothing better exists. */
function errorLabel(err) {
  const { codes, names } = errorCodes(err);
  const shown = codes.length > 0 ? codes : names;
  return [...new Set(shown)].join("/") || "UNKNOWN";
}

function describeError(err) {
  return `${errorLabel(err)}: ${err?.cause?.message ?? err?.message ?? String(err)}`;
}

/**
 * Report a condition that is not this repo's fault and decide its exit code.
 *
 * `hardenedByRequireLive` is the whole separation of concerns. It is true for
 * the "our custom domain is not answering" conditions — the ones that are only
 * excusable while the domain is still being wired up, and that
 * SMOKE_REQUIRE_LIVE exists to retire. It is false for upstream-outage
 * conditions: httpbingo.org is a third party, so its downtime must keep
 * degrading to a warning even under SMOKE_REQUIRE_LIVE, or a stranger's outage
 * would permanently red this repo's CI.
 */
function tolerate(message, { annotate, hardenedByRequireLive, skipNote = "" }) {
  if (hardenedByRequireLive && REQUIRE_LIVE) {
    // `skipNote` is dropped here on purpose — it says why this is being
    // forgiven, which is precisely what is no longer true.
    error(`${message} SMOKE_REQUIRE_LIVE is set — ${baseUrl} is expected to be live, so this is a failure.`);
    return "fail";
  }
  annotate(`${message}${skipNote}`);
  return "skip";
}

/** The custom domain is not (yet) serving us. Excusable only before it is live. */
const notLiveYet = (message) =>
  tolerate(message, {
    annotate: notice,
    hardenedByRequireLive: true,
    skipNote: " Skipping the smoke test.",
  });

/** We could not reach the domain at all. Same bucket: a live domain answers. */
const unreachable = (message) =>
  tolerate(message, {
    annotate: warning,
    hardenedByRequireLive: true,
    skipNote: " Treating as a transient network fault rather than a deployment failure.",
  });

/** httpbingo.org is down or throttling us. Never our deploy's fault — never hardened. */
const upstreamOutage = (message) =>
  tolerate(message, {
    annotate: warning,
    hardenedByRequireLive: false,
    skipNote: " Treating as an upstream outage, not a failure.",
  });

/**
 * Sort a network-level failure into one of the three buckets.
 *
 * Anything not explicitly recognised as "not provisioned yet" or "transient"
 * is a HARD FAILURE. That default matters: an unrecognised error must never be
 * able to produce a green run, which is what would let an expired certificate
 * or a broken TLS handshake pass as "not deployed yet".
 */
function classifyNetworkError(err, url) {
  if (matchesAny(err, NOT_PROVISIONED_ERROR_CODES)) {
    return notLiveYet(
      `${baseUrl} is not reachable yet (${errorLabel(err)}) — the custom domain is not ` +
        `attached, its certificate is still provisioning, or only its AAAA record has propagated.`,
    );
  }

  if (matchesAny(err, RETRYABLE_ERROR_CODES)) {
    return unreachable(`Could not reach ${url} after ${MAX_ATTEMPTS} attempts (${describeError(err)}).`);
  }

  error(`Request to ${url} failed: ${describeError(err)}`);
  return "fail";
}

async function attemptFetch(url) {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: { "user-agent": "zfb-example-reverse-proxy-smoke/1.0" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return { response };
  } catch (err) {
    return { err };
  }
}

/** Fetch with bounded retries on transient errors and congestion statuses. */
async function fetchWithRetry(url) {
  let result;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    result = await attemptFetch(url);

    const retryable = result.err
      ? matchesAny(result.err, RETRYABLE_ERROR_CODES)
      : UPSTREAM_FLAKE_STATUSES.has(result.response.status);
    if (!retryable) return result;

    const reason = result.err ? describeError(result.err) : `HTTP ${result.response.status}`;
    if (attempt < MAX_ATTEMPTS) {
      const delay = RETRY_BACKOFF_MS[attempt - 1] ?? RETRY_BACKOFF_MS.at(-1);
      console.log(`  attempt ${attempt}/${MAX_ATTEMPTS} failed (${reason}) — retrying in ${delay}ms`);
      await sleep(delay);
    } else {
      console.log(`  attempt ${attempt}/${MAX_ATTEMPTS} failed (${reason}) — giving up`);
    }
  }
  return result;
}

/** Assertion 1: the site itself is served on the custom domain. */
async function checkHomePage() {
  const url = `${baseUrl}/`;
  console.log(`GET ${url}`);
  const { response, err } = await fetchWithRetry(url);

  if (err) return classifyNetworkError(err, url);

  if (NOT_PROVISIONED_STATUSES.has(response.status)) {
    return notLiveYet(
      `${baseUrl} returned HTTP ${response.status} — DNS resolves to Cloudflare but no Worker is ` +
        `bound to this hostname yet.`,
    );
  }

  if (response.status !== 200) {
    error(`GET / returned HTTP ${response.status}, expected 200.`);
    return "fail";
  }

  const contentType = response.headers.get("content-type") ?? "";
  const body = await response.text();

  if (!contentType.includes("text/html")) {
    error(`GET / returned content-type "${contentType}", expected text/html.`);
    return "fail";
  }
  if (!body.includes(CONTENT_MARKER)) {
    error(`GET / did not contain the content marker "${CONTENT_MARKER}" — wrong site on this domain?`);
    return "fail";
  }

  console.log(`  ok — 200 text/html containing "${CONTENT_MARKER}"`);
  return "pass";
}

/**
 * Assertion 2: the proxy really proxies.
 *
 * httpbingo's /anything echo returns query args as ARRAYS of strings (verified
 * against the live upstream), so `args.via === ["zfb"]` plus the echoed
 * httpbingo URL is something the static asset layer could never produce.
 */
function upstreamShapeProblems(json) {
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    return ["response body is not a JSON object"];
  }

  const problems = [];
  if (json.method !== "GET") {
    problems.push(`expected method "GET", got ${JSON.stringify(json.method)}`);
  }

  const via = json.args?.via;
  if (!Array.isArray(via) || !via.includes("zfb")) {
    problems.push(`expected args.via to be an array containing "zfb", got ${JSON.stringify(via)}`);
  }

  let echoedHost;
  try {
    echoedHost = new URL(json.url).host;
  } catch {
    echoedHost = undefined;
  }
  if (echoedHost !== UPSTREAM_HOST) {
    problems.push(`expected the echoed url host to be ${UPSTREAM_HOST}, got ${JSON.stringify(json.url)}`);
  }

  return problems;
}

async function checkProxyPath() {
  const url = `${baseUrl}${PROXY_PATH}`;
  console.log(`GET ${url}`);
  const { response, err } = await fetchWithRetry(url);

  if (err) return classifyNetworkError(err, url);

  const contentType = response.headers.get("content-type") ?? "";
  const body = await response.text();

  // Our own Worker's error responses (see lib/proxy.ts) are text/plain.
  if (contentType.startsWith("text/plain")) {
    if (body.startsWith("Upstream fetch failed:")) {
      return upstreamOutage(
        `The Worker IS running on ${baseUrl} (it returned its own proxy error), but the upstream ` +
          `${UPSTREAM_HOST} could not be reached: ${body.trim()}.`,
      );
    }
    if (body.startsWith("PROXY_ORIGIN is not configured")) {
      error(`The Worker is running but PROXY_ORIGIN is missing from the deployment: ${body.trim()}`);
      return "fail";
    }
  }

  if (UPSTREAM_FLAKE_STATUSES.has(response.status)) {
    return upstreamOutage(
      `${PROXY_PATH} returned HTTP ${response.status} after ${MAX_ATTEMPTS} attempts — ` +
        `${UPSTREAM_HOST} is congested or down.`,
    );
  }

  // The asset layer answering here means the Worker never ran for this path.
  if (response.status === 404 || contentType.includes("text/html")) {
    error(
      `${PROXY_PATH} returned HTTP ${response.status} ${contentType} — the static asset layer answered ` +
        `instead of the Worker running the proxy route.`,
    );
    return "fail";
  }

  if (response.status !== 200) {
    error(`${PROXY_PATH} returned HTTP ${response.status}, expected 200.`);
    return "fail";
  }
  if (!contentType.includes("application/json")) {
    error(`${PROXY_PATH} returned content-type "${contentType}", expected application/json.`);
    return "fail";
  }

  let json;
  try {
    json = JSON.parse(body);
  } catch {
    error(`${PROXY_PATH} returned 200 application/json but the body did not parse as JSON.`);
    return "fail";
  }

  const problems = upstreamShapeProblems(json);
  if (problems.length > 0) {
    error(`${PROXY_PATH} returned 200 JSON that did not come from ${UPSTREAM_HOST}: ${problems.join("; ")}`);
    return "fail";
  }

  console.log(`  ok — 200 JSON echoed by ${UPSTREAM_HOST}; the Worker is proxying on this domain`);
  return "pass";
}

async function main() {
  console.log(`Smoke testing ${baseUrl}`);
  console.log(
    REQUIRE_LIVE
      ? `SMOKE_REQUIRE_LIVE=1 — the domain must be live; only an ${UPSTREAM_HOST} outage may still pass.\n`
      : `SMOKE_REQUIRE_LIVE is not set — a not-yet-live domain will skip instead of failing.\n`,
  );

  const home = await checkHomePage();
  if (home === "fail") process.exit(1);
  if (home === "skip") process.exit(0);

  const proxy = await checkProxyPath();
  if (proxy === "fail") process.exit(1);
  if (proxy === "skip") process.exit(0);

  console.log(`\nSmoke test passed — ${baseUrl} serves this site and proxies to ${UPSTREAM_HOST}.`);
}

await main();
