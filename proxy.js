// proxy.js (ESM)
import http from "http";
import { spawn } from "child_process";
import httpProxy from "http-proxy";

const INTERNAL_PORT = 10000;                   // child (MCP) listens here on localhost
const PUBLIC_PORT  = process.env.PORT || 3000; // Render injects PORT

console.log("ENV sanity:", {
  HAS_API_KEY: !!process.env.CLICKUP_API_KEY,
  HAS_TEAM_ID: !!process.env.CLICKUP_TEAM_ID,
  ENABLE_SSE: process.env.ENABLE_SSE,
  PUBLIC_PORT: String(PUBLIC_PORT),
});

// ---- Start the ClickUp MCP child (http + sse expected on 127.0.0.1:10000) ----
console.log("[child] starting ClickUp MCP (taazkareem latest) …");
const child = spawn(
  "bash",
  ["-lc", "npx -y @taazkareem/clickup-mcp-server@latest"],
  {
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(INTERNAL_PORT),
      ENABLE_SSE: "true",
    },
    stdio: "inherit",
    shell: false,
  }
);
child.on("exit", (code) => {
  console.error(`[child] exited with code: ${code}`);
});

// ---- Reverse proxy to the child on localhost:10000 ----
const proxy = httpProxy.createProxyServer({
  target: `http://127.0.0.1:${INTERNAL_PORT}`,
  changeOrigin: true,
  ws: true,
  proxyTimeout: 600000,
  timeout: 600000,
});

proxy.on("error", (err, req, res) => {
  console.error("Proxy error:", err?.message, "for", req?.url);
  if (res && !res.headersSent) {
    try {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end("bad gateway");
    } catch {}
  }
});

// ---- Public server (what Render hits) ----
const server = http.createServer(async (req, res) => {
  const url = req.url || "/";
  console.log("[req]", req.method, url);

  // Home page (helps Render see an immediate HTTP 200)
  if (url === "/" || url.startsWith("/?")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(`
      <h1>ClickUp MCP Proxy</h1>
      <ul>
        <li><a href="/ping">/ping</a></li>
        <li><a href="/health">/health</a></li>
        <li><a href="/test-sse">/test-sse (built-in)</a></li>
        <li><a href="/sse">/sse (proxied to child)</a></li>
      </ul>
    `);
  }

  // Quick checks (match even with query strings)
  if (url.startsWith("/ping")) {
    console.log("[ping] hit");
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end("pong");
  }

  // Always-OK health so Render doesn’t kill us
  if (url.startsWith("/health")) {
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end("ok");
  }

  // Built-in test SSE to prove streaming on Render (no proxy involved)
  if (url.startsWith("/test-sse")) {
    console.log("[test-sse] start");
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      "connection": "keep-alive",
      "x-accel-buffering": "no",        // tell proxies not to buffer
    });
    res.flushHeaders?.();               // send headers immediately if available

    // Initial hello + recommend client retry interval
    res.write("retry: 10000\n");
    res.write("event: hello\n");
    res.write("data: connected\n\n");

    const iv = setInterval(() => {
      res.write(`data: ${Date.now()}\n\n`);
    }, 5000);

    req.on("close", () => {
      console.log("[test-sse] client closed");
      clearInterval(iv);
    });
    return; // keep the connection open
  }

  // Everything else (including /sse and /mcp) goes to the child
  proxy.web(req, res);
});

// Pass-through upgrades (WS); SSE does NOT use this, but safe to keep
server.on("upgrade", (req, socket, head) => {
  console.log("[upgrade]", req.url);
  proxy.ws(req, socket, head);
});

// Be generous with timeouts for streaming
server.headersTimeout   = 600_000;
server.keepAliveTimeout = 600_000;
server.requestTimeout   = 0; // disable request timeout

server.listen(PUBLIC_PORT, "0.0.0.0", () => {
  console.log(`Proxy listening on 0.0.0.0:${PUBLIC_PORT} → 127.0.0.1:${INTERNAL_PORT}`);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  try { child.kill("SIGTERM"); } catch {}
  server.close(() => process.exit(0));
});
