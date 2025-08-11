import http from "http";
import { spawn } from "child_process";
import httpProxy from "http-proxy";
import fetch from "node-fetch";

const INTERNAL_PORT = 10000;                  // where the MCP server will listen (localhost only)
const PUBLIC_PORT = process.env.PORT || 3000; // Render provides PORT
const env = { ...process.env, PORT: String(INTERNAL_PORT) };

// 1) Start the ClickUp MCP server as a child process (binds to 127.0.0.1:10000)
const child = spawn("npx", ["-y", "@taazkareem/clickup-mcp-server@latest"], {
  env,
  stdio: "inherit",
  shell: false
});

console.log("ENV sanity:", {
  HAS_API_KEY: !!env.CLICKUP_API_KEY,
  HAS_TEAM_ID: !!env.CLICKUP_TEAM_ID,
  ENABLE_SSE: env.ENABLE_SSE
});

child.on("exit", (code) => {
  console.error(`MCP server exited with code ${code}`);
  process.exit(code || 1);
});

// 2) Create a reverse proxy that binds to 0.0.0.0:$PORT and forwards to 127.0.0.1:10000
const proxy = httpProxy.createProxyServer({
  target: `http://127.0.0.1:${INTERNAL_PORT}`,
  changeOrigin: true,
  ws: true
});

proxy.on("error", (err) => {
  console.error("Proxy error:", err.message);
});

const server = http.createServer(async (req, res) => {
  if (req.url === "/health") {
    try {
      const r = await fetch(`http://127.0.0.1:${INTERNAL_PORT}/health`);
      res.writeHead(r.status, Object.fromEntries(r.headers));
      res.end(await r.text());
    } catch (e) {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end("bad gateway");
    }
    return;
  }
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
  server.close(() => process.exit(0));
  child.kill("SIGTERM");
});
