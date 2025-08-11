// proxy.js
import http from "http";
import { spawn } from "child_process";
import httpProxy from "http-proxy";
import fetch from "node-fetch";

const INTERNAL_PORT = 10000;                 // child (MCP) listens here on localhost
const PUBLIC_PORT  = Number(process.env.PORT || 3000); // Render sets PORT

// --- start the ClickUp MCP child (HTTP+SSE enabled) ---
const childEnv = {
  ...process.env,
  PORT: String(INTERNAL_PORT),          // child binds to 127.0.0.1:10000
  ENABLE_SSE: process.env.ENABLE_SSE || "true",
  ENABLE_STDIO: "false",                // we’re using HTTP transport
};

console.log("ENV sanity:", {
  HAS_API_KEY: !!childEnv.CLICKUP_API_KEY,
  HAS_TEAM_ID: !!childEnv.CLICKUP_TEAM_ID,
  ENABLE_SSE: childEnv.ENABLE_SSE,
  PUBLIC_PORT: String(PUBLIC_PORT),
});

console.log("[child] starting ClickUp MCP (taazkareem latest, http+sse) …");
const child = spawn("npx", ["-y", "@taazkareem/clickup-mcp-server@latest"], {
  env: childEnv,
  stdio: ["ignore", "pipe", "pipe"],
  shell: false,
});
child.stdout.on("data", d => process.stdout.write(d));
child.stderr.on("data", d => process.stderr.write(d));
child.on("exit", code => console.error("[child] exited with code:", code));

// --- reverse proxy to the child ---
const proxy = httpProxy.createProxyServer({
  target: `http://127.0.0.1:${INTERNAL_PORT}`,
  changeOrigin: true,
  ws: true,                 // (not used by SSE, but harmless)
  proxyTimeout: 60 * 60 * 1000,
  timeout: 60 * 60 * 1000,
});

// add CORS + streaming-friendly headers on **all** proxied responses
proxy.on("proxyRes", (proxyRes, req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Max-Age", "86400");
  // help proxies not buffer SSE
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("X-Accel-Buffering", "no");
});

proxy.on("error", (err, req, res) => {
  console.error("Proxy error:", err.message);
  if (!res.headersSent) {
    res.writeHead(502, { "content-type": "text/plain" });
  }
  res.end("bad gateway");
});

// tiny helper to talk to the child directly
async function childFetch(path, opts = {}) {
  return fetch(`http://127.0.0.1:${INTERNAL_PORT}${path}`, opts);
}

// --- public HTTP server ---
const server = http.createServer(async (req, res) => {
  // CORS preflight: terminate here so the child never sees OPTIONS
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Max-Age": "86400",
    });
    return res.end();
  }

  // lightweight health for Render router
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end("ok");
  }

  // diagnostics (server → child)
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

  if (req.url === "/ping") {
    console.log("[ping] hit");
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end("pong");
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
