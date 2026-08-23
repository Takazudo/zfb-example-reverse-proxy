import assert from "node:assert/strict";
import test from "node:test";

import { createRouteAwareWorker } from "./route-aware-dispatch.ts";

function recordingWorker() {
  const calls = [];
  return {
    calls,
    worker: createRouteAwareWorker({
      async fetch(request, env, ctx) {
        calls.push({ request, env, ctx });
        return new Response("ok");
      },
    }),
  };
}

test("masks ASSETS and preserves an encoded proxy URL", async () => {
  const { calls, worker } = recordingWorker();
  const assets = { fetch: async () => new Response("asset") };
  const env = { ASSETS: assets, PROXY_ORIGIN: "https://origin.example" };
  const ctx = { marker: "ctx" };
  const url = "https://example.com/proxy/echo/a%2Fb?via=encoded";

  await worker.fetch(new Request(url), env, ctx);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].request.url, url);
  assert.equal(calls[0].env.ASSETS, undefined);
  assert.equal(calls[0].env.PROXY_ORIGIN, env.PROXY_ORIGIN);
  assert.equal(calls[0].ctx, ctx);
});

test("keeps the original environment for non-proxy routes", async () => {
  const { calls, worker } = recordingWorker();
  const env = { ASSETS: { fetch: async () => new Response("asset") } };

  await worker.fetch(new Request("https://example.com/proxy-not-a-route"), env, {});

  assert.equal(calls.length, 1);
  assert.equal(calls[0].env, env);
});
