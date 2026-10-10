/** Exercise the built Worker against loopback only; never uses PROXY_ORIGIN from production. */
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}
async function close(server) {
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
}
async function freePort() {
  const server = createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

export async function withLocalWorker(project, check) {
  let firstUpload;
  let releaseDownload;
  const uploadReceived = new Promise((done) => {
    firstUpload = done;
  });
  const downloadReleased = new Promise((done) => {
    releaseDownload = done;
  });
  const upstream = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === "/stream") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("first\n");
      await downloadReleased;
      res.end("last\n");
      return;
    }
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (url.pathname === "/upload") firstUpload();
    }
    if (url.pathname.startsWith("/status/")) {
      res.writeHead(Number(url.pathname.split("/").at(-1)), {
        "content-type": "text/plain",
        "x-upstream": "kept",
      });
      res.end(`upstream ${url.pathname}`);
    } else if (url.pathname === "/redirect-to") {
      res.writeHead(302, { location: url.searchParams.get("url") });
      res.end();
    } else if (url.pathname === "/headers") {
      res.writeHead(200, {
        "content-type": "text/plain",
        "x-upstream": "kept",
        "set-cookie": "upstream=secret",
        "content-security-policy": "default-src 'none'",
        "content-security-policy-report-only": "default-src 'none'",
        "strict-transport-security": "max-age=31536000",
        "proxy-test": "strip",
      });
      res.end("headers");
    } else {
      res.writeHead(200, {
        "content-type": "application/json",
        "x-upstream": "kept",
      });
      res.end(
        JSON.stringify({
          method: req.method,
          path: req.url,
          body,
          headers: req.headers,
        }),
      );
    }
  });
  const upstreamPort = await listen(upstream);
  const port = await freePort();
  const inspectorPort = await freePort();
  const origin = `http://127.0.0.1:${upstreamPort}`;
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(
    process.execPath,
    [
      resolve(project, "node_modules/wrangler/bin/wrangler.js"),
      "dev",
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--inspector-port",
      String(inspectorPort),
      "--var",
      `PROXY_ORIGIN:${origin}`,
    ],
    {
      cwd: project,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    },
  );
  let logs = "";
  child.stdout.on("data", (data) => {
    logs += data;
  });
  child.stderr.on("data", (data) => {
    logs += data;
  });
  const exited = once(child, "exit");
  const timeout = setTimeout(() => {
    console.error("Local Worker test timed out\n" + logs);
    child.kill("SIGKILL");
    process.exitCode = 1;
  }, 120_000);
  try {
    let ready = false;
    for (let attempt = 0; attempt < 150; attempt++) {
      if (child.exitCode !== null) throw new Error(logs);
      try {
        const response = await fetch(base, {
          signal: AbortSignal.timeout(1000),
        });
        await response.text();
        if (response.status === 200) {
          ready = true;
          break;
        }
      } catch {
        /* wait for local workerd */
      }
      await delay(200);
    }
    assert.ok(ready, `Worker did not become ready\n${logs}`);
    await check({
      base,
      origin,
      uploadReceived,
      releaseDownload,
      stopUpstream: () => close(upstream),
    });
  } catch (error) {
    console.error(logs);
    throw error;
  } finally {
    clearTimeout(timeout);
    releaseDownload();
    if (child.exitCode === null) child.kill("SIGTERM");
    await exited;
    if (upstream.listening) await close(upstream);
  }
}

export async function testLocal(project = process.cwd()) {
  await withLocalWorker(
    project,
    async ({ base, origin, uploadReceived, releaseDownload, stopUpstream }) => {
      const get = (path, init = {}) => {
        // Node fetch owns Sec-Fetch-Mode; use HTTP directly for real navigation headers.
        if (init.headers?.["sec-fetch-mode"] === "navigate") {
          return new Promise((done, reject) => {
            const req = httpRequest(
              base + path,
              {
                ...init,
                headers: {
                  ...init.headers,
                  ...(init.body === undefined
                    ? {}
                    : { "content-length": Buffer.byteLength(init.body) }),
                },
                signal: AbortSignal.timeout(10_000),
              },
              async (res) => {
                try {
                  const chunks = [];
                  for await (const chunk of res) chunks.push(chunk);
                  done(
                    new Response(Buffer.concat(chunks), {
                      status: res.statusCode,
                      headers: res.headers,
                    }),
                  );
                } catch (error) {
                  reject(error);
                }
              },
            );
            req.on("error", reject);
            req.end(init.body);
          });
        }
        return fetch(base + path, {
          ...init,
          redirect: "manual",
          signal: AbortSignal.timeout(10_000),
        });
      };
      const home = await get("/");
      assert.equal(home.status, 200);
      const html = await home.text();
      assert.match(html, /Reverse proxy under/);
      const cssPath = html.match(/href="([^\"]+\.css)"/)[1];
      const css = await get(cssPath);
      assert.equal(css.status, 200);
      assert.equal(
        await css.text(),
        await readFile(resolve(project, "dist", "." + cssPath), "utf8"),
      );
      for (const path of ["/missing", "/proxy-not-a-route"]) {
        const response = await get(path);
        assert.equal(response.status, 404, path);
        assert.match(await response.text(), /Route not found/);
      }
      for (const path of ["/proxy", "/proxy/"]) {
        const response = await get(path);
        console.log(
          `${path}: ${response.status} ${response.headers.get("location") ?? ""}`,
        );
        assert.equal(response.status, 404, path);
        if (path === "/proxy/")
          assert.equal(await response.text(), "404 Not Found");
        else assert.match(await response.text(), /Route not found/);
      }
      for (const navigate of [false, true]) {
        const headers = navigate ? { "sec-fetch-mode": "navigate" } : {};
        for (const method of [
          "GET",
          "POST",
          "PUT",
          "PATCH",
          "DELETE",
          "OPTIONS",
        ]) {
          const body = ["GET", "OPTIONS"].includes(method)
            ? undefined
            : "hello\u0000世界";
          const response = await get("/proxy/echo/a%2Fb?x=one&x=two", {
            method,
            body,
            headers: {
              ...headers,
              "x-client": "forward",
              "proxy-test": "strip",
            },
          });
          assert.equal(response.status, 200, method);
          const echo = await response.json();
          assert.equal(echo.method, method);
          if (navigate)
            assert.equal(echo.headers["sec-fetch-mode"], "navigate");
          assert.equal(echo.path, "/echo/a%2Fb?x=one&x=two");
          assert.equal(echo.body, body ?? "");
          assert.equal(echo.headers["x-client"], "forward");
          assert.equal(echo.headers["proxy-test"], undefined);
          assert.equal(echo.headers.host, new URL(origin).host);
        }
        for (const status of [404, 500]) {
          const response = await get(`/proxy/status/${status}`, { headers });
          assert.equal(response.status, status);
          assert.equal(response.headers.get("x-upstream"), "kept");
          assert.equal(await response.text(), `upstream /status/${status}`);
        }
      }
      const { stdout } = await promisify(execFile)("curl", [
        "--fail",
        "--silent",
        "--show-error",
        "--path-as-is",
        base + "/proxy/echo/a%2Fb?raw=1",
      ]);
      assert.equal(JSON.parse(stdout).path, "/echo/a%2Fb?raw=1");
      const head = await get("/proxy/echo", { method: "HEAD" });
      assert.equal(head.status, 200);
      assert.equal(await head.text(), "");
      for (const [location, expected] of [
        [`${origin}/echo?x=1#hash`, "/proxy/echo?x=1#hash"],
        ["/echo?x=2", "/proxy/echo?x=2"],
        ["echo?x=3", "/proxy/echo?x=3"],
        [
          "https://example.invalid/elsewhere",
          "https://example.invalid/elsewhere",
        ],
      ]) {
        const response = await get(
          "/proxy/redirect-to?url=" + encodeURIComponent(location),
        );
        assert.equal(response.status, 302);
        assert.equal(response.headers.get("location"), expected);
        await response.text();
      }
      const headers = await get("/proxy/headers");
      assert.equal(headers.status, 200);
      assert.equal(headers.headers.get("x-upstream"), "kept");
      for (const name of [
        "set-cookie",
        "content-security-policy",
        "content-security-policy-report-only",
        "strict-transport-security",
        "proxy-test",
      ]) {
        assert.equal(headers.headers.get(name), null, name);
      }
      assert.equal(await headers.text(), "headers");
      // Disable transport compression so its buffering cannot hide stream delivery.
      const stream = await get("/proxy/stream", {
        headers: { "accept-encoding": "identity" },
      });
      const reader = stream.body.getReader();
      const first = await reader.read();
      assert.equal(new TextDecoder().decode(first.value), "first\n");
      assert.equal(first.done, false);
      releaseDownload();
      let rest = "";
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        rest += new TextDecoder().decode(chunk.value);
      }
      assert.equal(rest, "last\n");
      let upload;
      const body = new ReadableStream({
        start(controller) {
          upload = controller;
          controller.enqueue(new TextEncoder().encode("first\n"));
        },
      });
      const pending = get("/proxy/upload", {
        method: "POST",
        body,
        duplex: "half",
      });
      await Promise.race([
        uploadReceived,
        delay(5000).then(() => {
          throw new Error("Upload was buffered instead of streamed");
        }),
      ]);
      upload.enqueue(new TextEncoder().encode("last\n"));
      upload.close();
      assert.equal((await (await pending).json()).body, "first\nlast\n");
      await stopUpstream();
      const failed = await get("/proxy/unavailable");
      assert.equal(failed.status, 502);
      assert.equal(failed.headers.get("cache-control"), "no-store");
      assert.match(failed.headers.get("content-type"), /text\/plain/);
      assert.match(await failed.text(), /^Upstream fetch failed:/);
      console.log(
        "Local Worker matrix passed: routing, methods, bodies, encoded paths, headers, redirects, statuses, streaming and dead upstream.",
      );
    },
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await testLocal(resolve(process.argv[2] ?? "."));
}
