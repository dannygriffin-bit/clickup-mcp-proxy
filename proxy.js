import http from "http";
import { spawn } from "child_process";
import httpProxy from "http-proxy";
import fetch from "node-fetch";

const INTERNAL_PORT = 10000;
const PUBLIC_PORT = process.env.PORT || 3000;

const env = {
  ...process.env,
  PORT: String(INTERNAL_PORT),
  DEBUG: "*",
  LOG_LEVEL: "debug"
};

console.log("ENV sanity:", {
  HAS_API_KEY: !!env.CLICKUP_API_KEY,
  HAS_TEAM_ID: !!env.CLICKUP_TEAM_ID,
  ENABLE_SSE: env.ENABLE_SSE,
  PUBLIC_PORT
});

// ---- preflight: prove npx exists ----
const npxCheck = spawn("bash", ["-lc", "npx --version"], { env, stdio: ["ignore", "pipe", "pipe"] });
npxCheck.stdout.on("data", d => console.log("[preflight] npx version:", String(d).trim()));
npxCheck.stderr.on("data", d => console.error("[preflight] npx stderr:", String(d).trim()));
npxCheck.on("exit", code => console.log("[preflight] npx exited with", code));

// ---- start the MCP child via bash -lc (so PATH/NPX resolve consistently) ----
console.log("[child] starting taazkareem server…");
const child = spawn("bash", ["-lc", "npx -y @taazkareem/clickup-mcp-server@0.7.2"], {
  env,
  stdio: ["ignore", "pipe", "pipe"]
});

child.stdout.on("data", d => process.stdout.write("[child stdout] " + d.toString()));
child.stderr.on("data", d => process.stderr.write("[child stderr] " + d.toString()));
child.on("error", err => console.error("[child error]", err));         // <— catch spawn errors
child.on("exit", code => console.error("[child exit] code", code));    // <— see exits

// ---- reverse proxy ----
const proxy = httpProxy.createProxyServer({
  target: `http://127.0.0.1:${INTERNAL_PORT}`,
  changeOrigin: true,
  ws: true
});
proxy.on("error", err => console.error("Proxy error:", err.message));

const server = http.createServer(async (req, res) => {
  if (req.url === "/health") {
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
server.listen(PUBLIC_PORT, "0.0.0.0", () =>
  console.log(`Proxy listening on 0.0.0.0:${PUBLIC_PORT} → 127.0.0.1:${INTERNAL_PORT}`)
);

// ---- internal health probe & auto-restart after 5 fails ----
const HEALTH_URL = `http://127.0.0.1:${INTERNAL_PORT}/health`;
let failCount = 0;
const MAX_FAILS = 5;

setInterval(async ()
