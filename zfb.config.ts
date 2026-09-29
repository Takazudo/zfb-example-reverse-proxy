import { defineConfig } from "@takazudo/zfb/config";

export default defineConfig({
  adapter: "@takazudo/zfb-adapter-cloudflare",
  wind: {
    spec: 1,
    reset: "owned-v1",
  },
});
