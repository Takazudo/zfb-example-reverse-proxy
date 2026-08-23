const PROXY_ROUTE_PREFIX = "/proxy/";

/**
 * @typedef {Record<string, unknown> & {
 *   ASSETS?: { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> }
 * }} WorkerEnv
 */

/**
 * @typedef {{
 *   fetch(request: Request, env: WorkerEnv, ctx: unknown): Promise<Response>
 * }} WorkerHandler
 */

/**
 * Preserve the adapter's generated dispatch behavior everywhere except the
 * dynamic proxy surface. Cloudflare's outer Static Assets router is configured
 * to run this Worker first for /proxy/*; masking ASSETS here also prevents the
 * generated wrapper from probing the asset binding and canonicalizing encoded
 * slashes before zfb handles the request.
 *
 * @param {WorkerHandler} generatedWorker
 * @returns {WorkerHandler}
 */
export function createRouteAwareWorker(generatedWorker) {
  return {
    async fetch(request, env, ctx) {
      const pathname = new URL(request.url).pathname;
      if (!pathname.startsWith(PROXY_ROUTE_PREFIX)) {
        return generatedWorker.fetch(request, env, ctx);
      }

      const { ASSETS: _assets, ...envWithoutAssets } = env;
      return generatedWorker.fetch(request, envWithoutAssets, ctx);
    },
  };
}
