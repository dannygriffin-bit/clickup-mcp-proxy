import http from "http";
import { spawn } from "child_process";
import httpProxy from "http-proxy";
import fetch from "node-fetch";

const INTERNAL_PORT = 10000;
const PUBLIC_PORT = process.env.PORT || 3000;

const env = {
  ...process.env,
  PORT: String(INTERNAL_PORT),
  DEBUG: "*",          // ask packages to be verbose if supported
  LOG_LEVEL: "debug"
};

console.log("ENV sanity:", {
  HAS_API_KEY: !!env.CLICKUP_API_KEY,
  HAS_TEAM_ID: !!env.CLICKUP_TEAM_ID,
  ENABLE_SSE: env.ENABLE_SSE,
  PUBLIC_PORT
});

// Start TaazKareem HTTP-capable server (should expose /health, /mcp, /sse)
const child = spawn("npx", ["-y", "@taazkareem/clickup-mcp-server@0.7.2"], {
  env,
  shell: false,
  stdio: ["ignore", "pipe", "pipe"]
});

child.stdout.on("data", (d) => process.stdout.write(d));
child.stderr.on("data", (d) => process.stderr.write(d));
child.on("exit", (code) => {
  console.error("MCP child exited with", code);
});

const proxy = httpProxy.createProxyServer({
  target: `http://127.0.0.1:${INTERNAL_PORT}`,
  changeOrigin: true,
  ws: true
});
proxy.on("error", (err) => console.error("Proxy error:", err.message));

const server = http.createServer(async (req, res) => {
  if (req.url === "/health") {
    try {
      const r = await fetch(`http://127.0.0.1:${INTERNAL_PORT}/health`);
      res.writeHead(r.status, Object.fromEntries(r.headers));
      res.end(await r.text());
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

// --- Health probe & auto-restart on repeated failures ---
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
