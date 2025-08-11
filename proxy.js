import http from "http";
import { spawn } from "child_process";
import httpProxy from "http-proxy";
import fetch from "node-fetch";

const INTERNAL_PORT = 10000;                  // MCP listens on 127.0.0.1 here
const PUBLIC_PORT = process.env.PORT || 3000; // Render provides PORT
const env = {
  ...process.env,
  PORT: String(INTERNAL_PORT),                // tell MCP to use INTERNAL_PORT
  // Optional: extra logging if the package supports it
  LOG_LEVEL: process.env.LOG_LEVEL || "debug"
};

// sanity print (no secrets)
console.log("ENV sanity:", {
  HAS_API_KEY: !!env.CLICKUP_API_KEY,
  HAS_TEAM_ID: !!env.CLICKUP_TEAM_ID,
  ENABLE_SSE: env.ENABLE_SSE,
  PUBLIC_PORT
});

// 1) Start the ClickUp MCP server (binds to 127.0.0.1:10000)
const child = spawn("npx", ["-y", "@taazkareem/clickup-mcp-server@0.7.2"], {
  env,
  shell: false,
  stdio: ["ignore", "pipe", "pipe"] // capture output
});

// log child output/errors so we can see why it crashes
child.stdout.on("data", (d) => process.stdout.write(d));
child.stderr.on("data", (d) => process.stderr.write(d));
child.on("exit", (code) => {
  console.error("MCP child exited with", code);
});

// 2) Reverse proxy on 0.0.0.0:$PORT -> 127.0.0.1:10000
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
    } catch {
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

// Graceful shutdown
process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
  child.kill("SIGTERM");
});
