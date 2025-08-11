// proxy.js
import http from "http";
import { spawn } from "child_process";
import httpProxy from "http-proxy";
import fetch from "node-fetch";

// Child (MCP) runs on localhost only:
const INTERNAL_PORT = 10000;

// Render assigns this; DO NOT override. If missing (local dev), use 3000.
const PUBLIC_PORT = process.env.PORT || 3000;

// ----- start MCP child -------------------------------------------------------
const childEnv = {
  ...process.env,
  PORT: String(INTERNAL_PORT),     // tell the MCP child which port to bind
  ENABLE_SSE: process.env.ENABLE_SSE || "true",
};

console.log("ENV sanity:", {
  HAS_API_KEY: !!childEnv.CLICKUP_API_KEY,
  HAS_TEAM_ID: !!childEnv.CLICKUP_TEAM_ID,
  ENABLE_SSE: childEnv.ENABLE_SSE,
  PUBLIC_PORT: String(PUBLIC_PORT),
});

// Using npx keeps your container small and always grabs the requested version.
const child = spawn(
  "npx",
  ["-y", "@taazkareem/clickup-mcp-server@0.7.2"],
  {
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  }
);

child.stdout.on("data", (d) => process.stdout.write(`[child] ${d}`));
child.stderr.on("data", (d) => process.stderr.write(`[child:err] ${d}`));
child.on("exit", (code) => console.error("[child] exited with code:", code));

// ----- reverse proxy to the child -------------------------------------------
const proxy = httpProxy.createProxyServer({
  target: `http://127.0.0.1:${INTERNAL_PORT}`,
  changeOrigin: true,
  ws: true,
  xfwd: true,
  proxyTimeout: 0,   // never time out SSE
});

proxy.on("proxyRes", (proxyRes, req) => {
  // Make sure Render/NGINX doesn’t buffer SSE
  if (req.url && req.url.startsWith("/sse")) {
    proxyRes.headers["X-Accel-Buffering"] = "no";
  }
});

proxy.on("error", (err, req, res) => {
  console.error("Proxy error:", err.message, "for", req.method, req.url);
  if (!res.headersSent) {
    res.writeHead(502, { "content-type": "text/plain" });
  }
  res.end("bad gateway");
});

// ----- tiny helpers ----------------------------------------------------------
const ok = (res, body = "ok") => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end(body);
};

// Simple SSE test generator (proves Render can stream)
function writeSSEHead(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
}

function sseTick(res) {
  res.write(`event: hello\n`);
  res.write(`data: ${Date.now()}\n\n`);
}

// ----- HTTP server -----------------------------------------------------------
const server = http.createServer(async (req, res) => {
  // minimal request logging
  console.log("[req]", req.method, req.url);

  if (req.url === "/ping") return ok(res, "pong");

  // Keep Render happy regardless of child state.
  if (req.url === "/health") return ok(res, "ok");

  // Local SSE test
  if (req.url === "/test-sse") {
    writeSSEHead(res);
    res.write("retry: 1000\n\n");
    const id = setInterval(() => sseTick(res), 1000);
    req.on("close", () => clearInterval(id));
    return;
  }

  // Debug: check if the child’s /health answers
  if (req.url === "/_child/health") {
    try {
      const r = await fetch(`http://127.0.0.1:${INTERNAL_PORT}/health`, {
        signal: AbortSignal.timeout(1500),
      });
      const text = await r.text().catch(() => "");
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true, status: r.status, body: text }));
    } catch (e) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: String(e) }));
    }
  }

  // Debug: does the child even expose /sse?
  if (req.url === "/_child/sse-check") {
    try {
      const r = await fetch(`http://127.0.0.1:${INTERNAL_PORT}/sse`, {
        headers: { accept: "text/event-stream" },
        signal: AbortSignal.timeout(1500),
      });
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true, status: r.status }));
    } catch (e) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: String(e) }));
    }
  }

  // Everything else proxies to the child (including /sse)
  proxy.web(req, res);
});

server.on("upgrade", (req, socket, head) => {
  proxy.ws(req, socket, head);
});

server.listen(PUBLIC_PORT, "0.0.0.0", () => {
  console.log(
    `Proxy listening on 0.0.0.0:${PUBLIC_PORT} → 127.0.0.1:${INTERNAL_PORT}`
  );
});

// Graceful shutdown
process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
  child.kill("SIGTERM");
});
