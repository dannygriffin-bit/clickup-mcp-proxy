// proxy.js — introspect child CLI and then try HTTP mode

import http from "http";
import { spawn } from "child_process";
import httpProxy from "http-proxy";
import fetch from "node-fetch";

const INTERNAL_PORT = 10000;                   // where we WANT the child to listen, if it supports HTTP
const PUBLIC_PORT  = process.env.PORT || 3000; // Render assigns this

// ---------- helpers ----------
function runOnce(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { ...opts, shell: false });
    let out = "", err = "";
    p.stdout?.on("data", (d) => (out += d.toString()));
    p.stderr?.on("data", (d) => (err += d.toString()));
    p.on("close", (code) => resolve({ code, out, err }));
  });
}

// Parse MCP_ARGS for experiments, default to trying common HTTP flags
const defaultArgs = [`--port`, String(INTERNAL_PORT), `--http`, `--enable-sse`];
const MCP_ARGS = (process.env.MCP_ARGS || defaultArgs.join(" "))
  .split(" ")
  .filter(Boolean);

console.log("ENV sanity:", {
  HAS_API_KEY: !!process.env.CLICKUP_API_KEY,
  HAS_TEAM_ID: !!process.env.CLICKUP_TEAM_ID,
  PUBLIC_PORT: String(PUBLIC_PORT),
});
console.log("[child] will run:", `npx -y @taazkareem/clickup-mcp-server@0.7.2 ${MCP_ARGS.join(" ")}`);

// ---------- start child ----------
const child = spawn("npx", ["-y", "@taazkareem/clickup-mcp-server@0.7.2", ...MCP_ARGS], {
  env: { ...process.env, PORT: String(INTERNAL_PORT) }, // just in case it reads PORT
  stdio: "inherit",
});
child.on("exit", (code) => console.error("[child] exited with code:", code));

// ---------- reverse proxy for non-SSE HTTP ----------
const proxy = httpProxy.createProxyServer({
  target: `http://127.0.0.1:${INTERNAL_PORT}`,
  changeOrigin: true,
  ws: true,
});
proxy.on("error", (err) => console.error("Proxy error:", err.message));

// ---------- public server ----------
const server = http.createServer(async (req, res) => {
  if (req.url === "/health") return void res.end("ok");
  if (req.url === "/ping") return void res.end("pong");

  // Show the child’s --help text so we know how to enable HTTP/SSE
  if (req.url === "/_child/help") {
    const { code, out, err } = await runOnce("npx", [
      "-y",
      "@taazkareem/clickup-mcp-server@0.7.2",
      "--help",
    ], { env: process.env });
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end(`exit=${code}\n\nSTDOUT:\n${out}\n\nSTDERR:\n${err}`);
    return;
  }

  // Probe child /health if it exists
  if (req.url === "/_child/health") {
    try {
      const r = await fetch(`http://127.0.0.1:${INTERNAL_PORT}/health`, { timeout: 3000 });
      res.writeHead(r.status, Object.fromEntries(r.headers));
      res.end(await r.text());
    } catch (e) {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end("child not reachable");
    }
    return;
  }

  proxy.web(req, res);
});

server.on("upgrade", (req, socket, head) => proxy.ws(req, socket, head));

server.listen(PUBLIC_PORT, "0.0.0.0", () => {
  console.log(`Proxy listening on 0.0.0.0:${PUBLIC_PORT} → 127.0.0.1:${INTERNAL_PORT}`);
});
process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
  try { child.kill("SIGTERM"); } catch {}
});
