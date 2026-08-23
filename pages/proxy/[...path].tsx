import { getCloudflareContext } from "@takazudo/zfb-adapter-cloudflare";

import { proxyRequest } from "../../lib/proxy";

export const prerender = false;

type Env = {
  PROXY_ORIGIN?: string;
};

export default async function ProxyPage() {
  const { env, request } = getCloudflareContext<Env>();
  return proxyRequest({
    request,
    origin: env.PROXY_ORIGIN,
    proxyPrefix: "/proxy/",
  });
}
