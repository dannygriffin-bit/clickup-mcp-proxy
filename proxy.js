// proxy.js
import http from "http";
import { spawn } from "child_process";
import httpProxy from "http-proxy";
import fetch from "node-fetch";
import { URL } from "url";

const INTERNAL_PORT = 10000;                          // HTTP bridge on localhost
const PUBLIC_PORT  = Number(process.env.PORT || 3000); // Render provides PORT

// --- env passed to the ClickUp child via the bridge (NO custom PORT here) ---
const childEnv = {
  CLICKUP_API_KEY: process.env.CLICKUP_API_KEY || "",
  CLICKUP_TEAM_ID: process.env.CLICKUP_TEAM_ID || "",
  DOCUMENT_SUPPORT: process.env.DOCUMENT_SUPPORT || "true",
  // include rest of current env (minus PORT to avoid confusing the child)
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "PORT")),
};

console.log("ENV sanity:", {
  HAS_API_KEY: !!childEnv.CLICKUP_API_KEY,
  HAS_TEAM_ID: !!childEnv.CLICKUP_TEAM_ID,
  PUBLIC_PORT: String(PUBLIC_PORT),
});

// --- start the MCP HTTP bridge, which spawns the ClickUp MCP (stdio) ---
console.log("[bridge] starting @modelcontextprotocol/server-http → taazkareem (stdio) …");

// We use bash -lc to keep quoting simple.
const bridgeCmd = [
  "-lc",
  [
    // Bind the bridge on localhost:10000
    `npx -y @modelcontextprotocol/server-http@latest`,
    `--host 127.0.0.1`,
    `--port ${INTERNAL_PORT}`,
    // Tell bridge to run a stdio MCP command:
    `--command 'npx -y @taazkareem/clickup-mcp-server@0.7.2'`,
  ].join(" "),
];

const bridge = spawn("bash", bridgeCmd, {
  env: childEnv,                // passes ClickUp creds to the child
  stdio: ["ignore", "pipe", "pipe"],
  shell: false,
});

bridge.stdout.on("data", d => process.stdout.write(d));
bridge.stderr.on("data", d => process.stderr.write(d));
bridge.on("exit", code => console.error("[bridge] exited with code:", code));

// --- reverse proxy to the bridge ---
const proxy = httpProxy.createProxyServer({
  target: `http://127.0.0.1:${INTERNAL_PORT}`,
  changeOrigin: true,
  ws: true,
  proxyTimeout: 60 * 60 * 1000,
  timeout: 60 * 60 * 1000,
});

proxy.on("proxyRes", (_proxyRes, _req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Max-Age", "86400");
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("X-Accel-Buffering", "no");
});

proxy.on("error", (err, _req, res) => {
  console.error("Proxy error:", err.message);
  if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
  res.end("bad gateway");
});

async function bridgeFetch(path, opts = {}) {
  return fetch(`http://127.0.0.1:${INTERNAL_PORT}${path}`, opts);
}

// --- public server (health, tests, then proxy) ---
const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Max-Age": "86400",
    });
    return res.end();
  }

  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end("ok");
  }

  if (req.url === "/_child/health") {
    try {
      const r = await bridgeFetch("/health");
      const txt = await r.text().catch(() => "");
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: r.ok, status: r.status, body: txt }));
    } catch (e) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: String(e) }));
    }
  }

  if (req.url.startsWith("/_child/try-sse")) {
    const u = new URL(req.url, "http://x");
    const path = u.searchParams.get("path") || "/sse";
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 2500);
    try {
      const r = await fetch(`http://127.0.0.1:${INTERNAL_PORT}${path}`, {
        headers: { Accept: "text/event-stream", "Cache-Control": "no-cache" },
        signal: controller.signal,
      });
      clearTimeout(t);
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

  if (req.url === "/ping") {
    console.log("[ping] hit");
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end("pong");
  }

  // self-contained SSE test
  if (req.url === "/test-sse") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(`<!doctype html>
<html>
  <body>
    <pre id="out">connecting…</pre>
    <script>
      const el = document.getElementById('out');
      const es = new EventSource('/test-sse/stream');
      es.onmessage = e => el.textContent += "\\n" + e.data;
      es.onerror   = e => el.textContent += "\\n[error]";
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
    const iv = setInterval(() => res.write(`data: ${Date.now()}\n\n`), 1000);
    req.on("close", () => clearInterval(iv));
    return;
  }

  // everything else → bridge
  proxy.web(req, res);
});

server.on("upgrade", (req, socket, head) => {
  proxy.ws(req, socket, head);
});

server.listen(PUBLIC_PORT, "0.0.0.0", () => {
  console.log(`Proxy listening on 0.0.0.0:${PUBLIC_PORT} → 127.0.0.1:${INTERNAL_PORT}`);
});

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
  try { bridge.kill("SIGTERM"); } catch {}
});
