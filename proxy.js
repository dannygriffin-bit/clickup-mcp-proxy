// proxy.js (ESM)
import http from "http";
import { spawn } from "child_process";
import httpProxy from "http-proxy";

// ---------- Config ----------
const INTERNAL_PORT = 10000;                  // MCP child binds here (localhost only)
const PUBLIC_PORT = process.env.PORT || 3000; // Render provides PORT for public listener

console.log("ENV sanity:", {
  HAS_API_KEY: !!process.env.CLICKUP_API_KEY,
  HAS_TEAM_ID: !!process.env.CLICKUP_TEAM_ID,
  ENABLE_SSE: process.env.ENABLE_SSE,
  PUBLIC_PORT: String(PUBLIC_PORT),
});

// ---------- Start MCP child (HTTP + SSE) ----------
console.log("[child] starting ClickUp MCP (taazkareem 0.7.2, http+sse) …");
const child = spawn(
  "bash",
  ["-lc", "npx -y @taazkareem/clickup-mcp-server@0.7.2 --http --sse"],
  {
    env: {
      ...process.env,
      PORT: String(INTERNAL_PORT), // child listens on 127.0.0.1:10000
      HOST: "127.0.0.1",
      ENABLE_SSE: "true",
    },
    stdio: "inherit",
    shell: false,
  }
);

child.on("exit", (code) => {
  console.error(`[child] exited with code: ${code}`);
});

// ---------- Reverse proxy (hardened) ----------
const proxy = httpProxy.createProxyServer({
  target: `http://127.0.0.1:${INTERNAL_PORT}`,
  changeOrigin: true,
  ws: true,
  proxyTimeout: 600000, // 10 min
  timeout: 600000,      // idle socket timeout
});

proxy.on("error", (err, req, res) => {
  console.error("Proxy error:", err.message);
  if (res && !res.headersSent) {
    try {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end("bad gateway");
    } catch {}
  }
});

// ---------- Public HTTP server ----------
const server = http.createServer((req, res) => {
  // 1) direct connectivity check (doesn't depend on child)
  if (req.url === "/ping") {
    console.log("[ping] hit");
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end("pong");
  }

  // 2) always-OK health so Render passes health checks
  if (req.url === "/health") {
    return res.end("ok");
  }

  // 3) everything else (/sse, /mcp, etc.) proxied to child
  proxy.web(req, res);
});

// WebSocket/SSE upgrade passthrough
server.on("upgrade", (req, socket, head) => {
  proxy.ws(req, socket, head);
});

server.listen(PUBLIC_PORT, "0.0.0.0", () => {
  console.log(`Proxy listening on 0.0.0.0:${PUBLIC_PORT} → 127.0.0.1:${INTERNAL_PORT}`);
});

// ---------- Graceful shutdown ----------
process.on("SIGTERM", () => {
  try { child.kill("SIGTERM"); } catch {}
  server.close(() => process.exit(0));
});
