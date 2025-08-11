// proxy.js (ESM)
import http from "http";
import { spawn } from "child_process";
import httpProxy from "http-proxy";

// ---------------- Config ----------------
const INTERNAL_PORT = 10000;                 // MCP child binds here (localhost only)
const PUBLIC_PORT = process.env.PORT || 3000; // Render provides PORT for the public listener

console.log("ENV sanity:", {
  HAS_API_KEY: !!process.env.CLICKUP_API_KEY,
  HAS_TEAM_ID: !!process.env.CLICKUP_TEAM_ID,
  ENABLE_SSE: process.env.ENABLE_SSE,
  PUBLIC_PORT: String(PUBLIC_PORT),
});

// ---------------- Start MCP child ----------------
// Pin to an HTTP/SSE-capable version and force SSE on.
console.log("[child] starting ClickUp MCP (taazkareem 0.7.2, http+sse) …");
const child = spawn(
  "bash",
  ["-lc", "npx -y @taazkareem/clickup-mcp-server@0.7.2 --http --sse"],
  {
    env: {
      ...process.env,
      PORT: String(INTERNAL_PORT),   // child listens on 127.0.0.1:10000
      HOST: "127.0.0.1",
      ENABLE_SSE: "true"
    },
    stdio: "inherit",
    shell: false
  }
);

child.on("exit", (code) => {
  console.error(`[child] exited with code: ${code}`);
});

// ---------------- Reverse proxy ----------------
const proxy = httpProxy.createProxyServer({
  target: `http://127.0.0.1:${INTERNAL_PORT}`,
  changeOrigin: true,
  ws: true,
});

proxy.on("error", (err) => {
  console.error("Proxy error:", err.message);
});

// ---------------- Public HTTP server ----------------
const server = http.createServer((req, res) => {
  // 1) direct ping that doesn't depend on the child (useful to prove Render routing works)
  if (req.url === "/ping") {
    console.log("[ping] hit");
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end("pong");
  }

  // 2) always-OK health for Render’s checks (don’t depend on child health)
  if (req.url === "/health") {
    return res.end("ok");
  }

  // 3) everything else (including /sse and /mcp) is proxied to the child
  proxy.web(req, res);
});

// WebSocket / SSE upgrade passthrough (needed for /sse)
server.on("upgrade", (req, socket, head) => {
  proxy.ws(req, socket, head);
});

server.listen(PUBLIC_PORT, "0.0.0.0", () => {
  console.log(`Proxy listening on 0.0.0.0:${PUBLIC_PORT} → 127.0.0.1:${INTERNAL_PORT}`);
});

// ---------------- Graceful shutdown ----------------
process.on("SIGTERM", () => {
  try { child.kill("SIGTERM"); } catch {}
  server.close(() => process.exit(0));
});
