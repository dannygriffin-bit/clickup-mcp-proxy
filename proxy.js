// proxy.js  (ESM)
// Purpose: expose a simple HTTP endpoint for Render (/ping, /health)
// and proxy everything else to the local ClickUp MCP server.

import http from "http";
import { spawn } from "child_process";
import httpProxy from "http-proxy";

// ----- Config -----
const INTERNAL_PORT = 10000;                 // where the MCP child will listen (localhost)
const PUBLIC_PORT = process.env.PORT || 3000; // Render assigns PORT; we fall back to 3000 for local runs

// Log what we have so we can debug quickly from Render logs
console.log("ENV sanity:", {
  HAS_API_KEY: !!process.env.CLICKUP_API_KEY,
  HAS_TEAM_ID: !!process.env.CLICKUP_TEAM_ID,
  ENABLE_SSE: process.env.ENABLE_SSE,
  PUBLIC_PORT: String(PUBLIC_PORT)
});

// ----- Start the MCP child process -----
// We set PORT for the child so it binds to 127.0.0.1:INTERNAL_PORT.
// (Do NOT override the parent's PORT; Render needs the parent to listen on process.env.PORT.)
console.log("[child] starting taazkareem server…");
const child = spawn(
  "npx",
  ["-y", "@taazkareem/clickup-mcp-server@0.6.1"], // ← try this older HTTP/SSE build
  {
    env: {
      ...process.env,
      PORT: String(INTERNAL_PORT),
      HOST: "127.0.0.1",
      ENABLE_SSE: "true"
    },
    stdio: "inherit",
    shell: false
  }
);

// If the child exits, just log. We keep the parent alive so /ping still works for debugging.
child.on("exit", (code) => {
  console.error(`[child] exited with code: ${code}`);
});

// ----- Reverse proxy to the child -----
const proxy = httpProxy.createProxyServer({
  target: `http://127.0.0.1:${INTERNAL_PORT}`,
  changeOrigin: true,
  ws: true
});

proxy.on("error", (err) => {
  console.error("Proxy error:", err.message);
});

// ----- HTTP server exposed to Render -----
const server = http.createServer((req, res) => {
  // Quick connectivity check that does NOT depend on the child:
  if (req.url === "/ping") {
    console.log("[ping] hit");
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end("pong");
  }

  // Always-OK health endpoint so Render’s health checks succeed.
  if (req.url === "/health") {
    return res.end("ok");
  }

  // Everything else goes to the MCP child on 127.0.0.1:INTERNAL_PORT
  proxy.web(req, res);
});

server.on("upgrade", (req, socket, head) => {
  proxy.ws(req, socket, head);
});

server.listen(PUBLIC_PORT, "0.0.0.0", () => {
  console.log(`Proxy listening on 0.0.0.0:${PUBLIC_PORT} → 127.0.0.1:${INTERNAL_PORT}`);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  try { child.kill("SIGTERM"); } catch {}
  server.close(() => process.exit(0));
});
