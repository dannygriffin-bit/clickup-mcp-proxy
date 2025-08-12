// proxy.js — print ClickUp MCP --help to logs, then run the child

import http from "http";
import { spawn } from "child_process";
import httpProxy from "http-proxy";

const INTERNAL_PORT = 10000;                   // target port for child *if* it supports HTTP
const PUBLIC_PORT  = process.env.PORT || 3000; // Render assigns this

function runOnce(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { ...opts, shell: false });
    let out = "", err = "";
    p.stdout?.on("data", (d) => (out += d.toString()));
    p.stderr?.on("data", (d) => (err += d.toString()));
    p.on("close", (code) => resolve({ code, out, err }));
  });
}

(async () => {
  console.log("ENV sanity:", {
    HAS_API_KEY: !!process.env.CLICKUP_API_KEY,
    HAS_TEAM_ID: !!process.env.CLICKUP_TEAM_ID,
    PUBLIC_PORT: String(PUBLIC_PORT),
  });

  // 1) Always print the package --help into logs so we can see real flags
  const help = await runOnce("npx", [
    "-y",
    "@taazkareem/clickup-mcp-server@0.7.2",
    "--help",
  ], { env: process.env });

  console.log("========== [HELP: clickup-mcp-server --help] ==========");
  console.log("exit:", help.code);
  console.log("--- STDOUT ---\n" + help.out);
  console.log("--- STDERR ---\n" + help.err);
  console.log("========================================================");

  // 2) Try to start the child in HTTP mode if you set MCP_ARGS in Render,
  //    otherwise just start it with no args (stdio-only).
  const defaultArgs = []; // stdio-only unless you set MCP_ARGS
  const MCP_ARGS = (process.env.MCP_ARGS || defaultArgs.join(" "))
    .split(" ")
    .filter(Boolean);

  console.log("[child] starting with args:", MCP_ARGS.join(" ") || "(none)");

  const child = spawn("npx", ["-y", "@taazkareem/clickup-mcp-server@0.7.2", ...MCP_ARGS], {
    env: { ...process.env, PORT: String(INTERNAL_PORT) },
    stdio: "inherit",
  });
  child.on("exit", (code) => console.error("[child] exited with code:", code));

  // 3) Reverse proxy (in case child exposes HTTP on 127.0.0.1:10000)
  const proxy = httpProxy.createProxyServer({
    target: `http://127.0.0.1:${INTERNAL_PORT}`,
    changeOrigin: true,
    ws: true,
  });
  proxy.on("error", (err) => console.error("Proxy error:", err.message));

  // 4) Public server for Render
  const server = http.createServer((req, res) => {
    if (req.url === "/health") return void res.end("ok");
    if (req.url === "/ping")   return void res.end("pong");
    // Forward anything else to the child (ok even if child isn't HTTP)
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
})();
