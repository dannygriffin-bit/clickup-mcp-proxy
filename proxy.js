import http from "http";
import { spawn } from "child_process";
import httpProxy from "http-proxy";
import fetch from "node-fetch";

const INTERNAL_PORT = 10000;                 // MCP server listens on 127.0.0.1 here
const PUBLIC_PORT = process.env.PORT || 3000; // Render provides PORT at runtime

// Env we pass to the MCP child
const env = {
  ...process.env,
  PORT: String(INTERNAL_PORT),               // tell MCP which internal port to bind
  DEBUG: "*",
  LOG_LEVEL: "debug"
};

// Sanity print (no secrets)
console.log("ENV sanity:", {
  HAS_API_KEY: !!env.CLICKUP_API_KEY,
  HAS_TEAM_ID: !!env.CLICKUP_TEAM_ID,
  ENABLE_SSE: env.ENABLE_SSE,
  PUBLIC_PORT
});

// ---------- Preflight: prove npx is available ----------
const npxCheck = spawn("bash", ["-lc", "npx --version"], {
  env,
  stdio: ["ignore", "pipe", "pipe"]
});
npxCheck.stdout.on("data", (d) =>
  console.log("[preflight] npx version:", String(d).trim())
);
npxCheck.stderr.on("data", (d) =>
  console.error("[preflight] npx stderr:", String(d).trim())
);
npxCheck.on("exit", (code) => console.log("[preflight] npx exited with", code));

// ---------- Start the ClickUp MCP server (HTTP mode) ----------
console.log("[child] starting taazkareem server…");
const child = spawn("bash", ["-lc", "npx -y @taazkareem/clickup-mcp-server@0.7.2"], {
  env,
  stdio: ["ignore", "pipe", "pipe"]
});

child.stdout.on("data", (d) => process.stdout.write("[child stdout] " + d.toString()));
child.stderr.on("data", (d) => process.stderr.write("[child stderr] " + d.toString()));
child.on("error", (err) => console.error("[child error]", err));
child.on("exit", (code) => console.error("[child exit] code", code));

// ---------- Reverse proxy (public -> internal localhost) ----------
const proxy = httpProxy.createProxyServer({
  target: `http://127.0.0.1:${INTERNAL_PORT}`,
  changeOrigin: true,
  ws: true
});
proxy.on("error", (err) => console.error("Proxy error:", err.message));

const server = http.createServer(async (req, res) => {
  if (req.url === "/health") {
    // Pass-through health check to the MCP child
    try {
      const r = await fetch(`http://127.0.0.1:${INTERNAL_PORT}/health`);
      const text = await r.text();
      res.writeHead(r.status, Object.fromEntries(r.headers));
      res.end(text);
    } catch (e) {
      console.error("[health] fetch error:", e?.message || e);
      res.writeHead(502, { "content-type": "text/plain" });
      res.end("bad gateway");
    }
    return;
  }
  proxy.web(req, res);
});

server.on("upgrade", (req, socket, head) => proxy.ws(req, socket, head));

server.listen(PUBLIC_PORT, "0.0.0.0", () => {
  console.log(`Proxy listening on 0.0.0.0:${PUBLIC_PORT} → 127.0.0.1:${INTERNAL_PORT}`);
});

// ---------- Internal health probe & auto-restart ----------
const HEALTH_URL = `http://127.0.0.1:${INTERNAL_PORT}/health`;
let failCount = 0;
const MAX_FAILS = 5;

setInterval(async () => {
  try {
    const res = await fetch(HEALTH_URL);
    const text = await res.text();
    console.log(`[health probe] status ${res.status}: ${text}`);
    failCount = 0; // reset on success
  } catch (err) {
    failCount += 1;
    console.error(`[health probe] error: ${err?.message || err} (fail ${failCount}/${MAX_FAILS})`);
    if (failCount >= MAX_FAILS) {
      console.error("[health probe] too many failures — exiting to let Render restart the service");
      process.exit(1);
    }
  }
}, 3000);

// ---------- Graceful shutdown ----------
process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
  child.kill("SIGTERM");
});
