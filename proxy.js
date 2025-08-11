// proxy.js
import http from "http";
import { spawn } from "child_process";
import httpProxy from "http-proxy";
import fetch from "node-fetch";
import { URL } from "url";

const INTERNAL_PORT = 10000;                         // child (MCP) on localhost
const PUBLIC_PORT  = Number(process.env.PORT || 3000); // Render sets PORT

// ---- start child (HTTP + SSE) ----
const childEnv = {
  ...process.env,
  PORT: String(INTERNAL_PORT),
  ENABLE_SSE: process.env.ENABLE_SSE || "true",
  ENABLE_STDIO: "false",
};

console.log("ENV sanity:", {
  HAS_API_KEY: !!childEnv.CLICKUP_API_KEY,
  HAS_TEAM_ID: !!childEnv.CLICKUP_TEAM_ID,
  ENABLE_SSE: childEnv.ENABLE_SSE,
  PUBLIC_PORT: String(PUBLIC_PORT),
});

console.log("[child] starting ClickUp MCP (taazkareem 0.7.2, http+sse) …");
const child = spawn("npx", ["-y", "@taazkareem/clickup-mcp-server@0.7.2"], {
  env: childEnv,
  stdio: ["ignore", "pipe", "pipe"],
  shell: false,
});
child.stdout.on("data", d => process.stdout.write(d));
child.stderr.on("data", d => process.stderr.write(d));
child.on("exit", code => console.error("[child] exited with code:", code));

// ---- proxy to child ----
const proxy = httpProxy.createProxyServer({
  target: `http://127.0.0.1:${INTERNAL_PORT}`,
  changeOrigin: true,
  ws: true,
  proxyTimeout: 60 * 60 * 1000,
  timeout: 60 * 60 * 1000,
});

proxy.on("proxyRes", (proxyRes, req, res) => {
  // CORS & streaming-friendly headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Max-Age", "86400");
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("X-Accel-Buffering", "no");
});

proxy.on("error", (err, req, res) => {
  console.error("Proxy error:", err.message);
  if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
  res.end("bad gateway");
});

async function childFetch(path, opts = {}) {
  return fetch(`http://127.0.0.1:${INTERNAL_PORT}${path}`, opts);
}

// ---- public server ----
const server = http.createServer(async (req, res) => {
  // terminate all preflights here
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Max-Age": "86400",
    });
    return res.end();
  }

  // Render health
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end("ok");
  }

  // child health
  if (req.url === "/_child/health") {
    try {
      const r = await childFetch("/health");
      const txt = await r.text().catch(() => "");
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: r.ok, status: r.status, body: txt }));
    } catch (e) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: String(e) }));
    }
  }

  // try child's SSE path quickly (defaults to /sse)
  if (req.url.startsWith("/_child/try-sse")) {
    const u = new URL(req.url, "http://x");
    const path = u.searchParams.get("path") || "/sse";
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 2000);
    try {
      const r = await fetch(`http://127.0.0.1:${INTERNAL_PORT}${path}`, {
        headers: { Accept: "text/event-stream", "Cache-Control": "no-cache" },
        signal: controller.signal,
      });
      clearTimeout(t);
      // abort immediately after headers so we don’t hang
      try { controller.abort(); } catch {}
      const headers = {};
      r.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ path, status: r.status, headers }));
    } catch (e) {
      clearTimeout(t);
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ path, error: String(e) }));
    }
  }

  // simple ping
  if (req.url === "/ping") {
    console.log("[ping] hit");
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end("pong");
  }

  // ====== self-contained SSE test (served by proxy itself) ======
  if (req.url === "/test-sse") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(`<!doctype html>
<html>
  <head><meta charset="utf-8"><title>SSE test</title></head>
  <body>
    <pre id="out">connecting…</pre>
    <script>
      const out = document.getElementById('out');
      const es = new EventSource('/test-sse/stream');
      es.onmessage = (e)=>{ out.textContent += '\\n' + e.data; };
      es.onerror = (e)=>{ out.textContent += '\\n[error]'; };
    </script>
  </body>
</html>`);
  }

  if (req.url === "/test-sse/stream") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 1000\n\n");
    const iv = setInterval(() => {
      res.write(`data: ${Date.now()}\n\n`);
    }, 1000);
    req.on("close", () => clearInterval(iv));
    return;
  }
  // ====== end self-test ======

  // Log SSE attempts from clients for debugging
  if (req.url.startsWith("/sse")) {
    console.log("[proxy] incoming /sse request", req.method, req.headers);
  }

  // everything else → child
  proxy.web(req, res);
});

server.on("upgrade", (req, socket, head) => {
  proxy.ws(req, socket, head);
});

server.listen(PUBLIC_PORT, "0.0.0.0", () => {
  console.log(`Proxy listening on 0.0.0.0:${PUBLIC_PORT} → 127.0.0.1:${INTERNAL_PORT}`);
});

// graceful shutdown
process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
  try { child.kill("SIGTERM"); } catch {}
});
