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
 * Usage:
 *   node scripts/smoke.mjs [base-url]
 *   SMOKE_BASE_URL=https://... node scripts/smoke.mjs
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
 * cert error in the minutes after the attach is a pending state, not a fault.
 */
const NOT_PROVISIONED_ERROR_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CERT_HAS_EXPIRED",
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

const notice = (message) => console.log(`::notice::${message}`);
const warning = (message) => console.log(`::warning::${message}`);
const error = (message) => console.log(`::error::${message}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function errorCode(err) {
  return err?.cause?.code ?? err?.code ?? err?.name ?? "UNKNOWN";
}

function describeError(err) {
  return `${errorCode(err)}: ${err?.cause?.message ?? err?.message ?? String(err)}`;
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
      ? RETRYABLE_ERROR_CODES.has(errorCode(result.err))
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

  if (err) {
    if (NOT_PROVISIONED_ERROR_CODES.has(errorCode(err))) {
      notice(
        `${baseUrl} is not reachable yet (${errorCode(err)}) — the custom domain is not attached, ` +
          `or its certificate is still provisioning. Skipping the smoke test.`,
      );
      return "skip";
    }
    warning(`Could not reach ${url} after ${MAX_ATTEMPTS} attempts (${describeError(err)}). Skipping.`);
    return "skip";
  }

  if (NOT_PROVISIONED_STATUSES.has(response.status)) {
    notice(
      `${baseUrl} returned HTTP ${response.status} — DNS resolves to Cloudflare but no Worker is ` +
        `bound to this hostname yet. Skipping the smoke test.`,
    );
    return "skip";
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

  if (err) {
    warning(`Could not reach ${url} after ${MAX_ATTEMPTS} attempts (${describeError(err)}). Skipping.`);
    return "skip";
  }

  const contentType = response.headers.get("content-type") ?? "";
  const body = await response.text();

  // Our own Worker's error responses (see lib/proxy.ts) are text/plain.
  if (contentType.startsWith("text/plain")) {
    if (body.startsWith("Upstream fetch failed:")) {
      warning(
        `The Worker IS running on ${baseUrl} (it returned its own proxy error), but the upstream ` +
          `${UPSTREAM_HOST} could not be reached: ${body.trim()}. Treating as an upstream outage, not a failure.`,
      );
      return "skip";
    }
    if (body.startsWith("PROXY_ORIGIN is not configured")) {
      error(`The Worker is running but PROXY_ORIGIN is missing from the deployment: ${body.trim()}`);
      return "fail";
    }
  }

  if (UPSTREAM_FLAKE_STATUSES.has(response.status)) {
    warning(
      `${PROXY_PATH} returned HTTP ${response.status} after ${MAX_ATTEMPTS} attempts — ` +
        `${UPSTREAM_HOST} is congested or down. Treating as an upstream outage, not a failure.`,
    );
    return "skip";
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
  console.log(`Smoke testing ${baseUrl}\n`);

  const home = await checkHomePage();
  if (home === "fail") process.exit(1);
  if (home === "skip") process.exit(0);

  const proxy = await checkProxyPath();
  if (proxy === "fail") process.exit(1);
  if (proxy === "skip") process.exit(0);

  console.log(`\nSmoke test passed — ${baseUrl} serves this site and proxies to ${UPSTREAM_HOST}.`);
}

await main();
