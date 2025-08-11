// proxy.js
import http from "http";
import { spawn } from "child_process";
import httpProxy from "http-proxy";
import fetch from "node-fetch";

const INTERNAL_PORT = 10000;
const PUBLIC_PORT = process.env.PORT || 3000;
const SSE_OVERRIDE = process.env.MCP_SSE_PATH || "/sse"; // set this in Render once we discover the real path

const childEnv = {
  ...process.env,
  PORT: String(INTERNAL_PORT),
  ENABLE_SSE: process.env.ENABLE_SSE || "true",
};

console.log("ENV sanity:", {
  HAS_API_KEY: !!childEnv.CLICKUP_API_KEY,
  HAS_TEAM_ID: !!childEnv.CLICKUP_TEAM_ID,
  ENABLE_SSE: childEnv.ENABLE_SSE,
  PUBLIC_PORT: String(PUBLIC_PORT),
  SSE_OVERRIDE,
});

// launch MCP child
const child = spawn("npx", ["-y", "@taazkareem/clickup-mcp-server@0.7.2"], {
  env: childEnv,
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", d => process.stdout.write(`[child] ${d}`));
child.stderr.on("data", d => process.stderr.write(`[child:err] ${d}`));
child.on("exit", code => console.error("[child] exited with code:", code));

const proxy = httpProxy.createProxyServer({
  target: `http://127.0.0.1:${INTERNAL_PORT}`,
  changeOrigin: true,
  ws: true,
  xfwd: true,
  proxyTimeout: 0,
});
proxy.on("proxyRes", (proxyRes, req) => {
  if (req.url && req.url.startsWith("/sse")) {
    proxyRes.headers["X-Accel-Buffering"] = "no";
  }
});
proxy.on("error", (err, req, res) => {
  console.error("Proxy error:", err.message, "for", req.method, req.url);
  if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
  res.end("bad gateway");
});

// helpers
const ok = (res, body = "ok") => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end(body);
};
const writeSSEHead = (res) => {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
};

// probe one path for SSE
async function probeSSE(path) {
  try {
    const r = await fetch(`http://127.0.0.1:${INTERNAL_PORT}${path}`, {
      headers: { accept: "text/event-stream" },
      signal: AbortSignal.timeout(5000),
    });
    return {
      path,
      status: r.status,
      ctype: r.headers.get("content-type") || null,
      ok: r.ok,
    };
  } catch (e) {
    return { path, error: String(e) };
  }
}

const CANDIDATE_PATHS = [
  "/sse",
  "/events",
  "/event",
  "/stream",
  "/mcp/sse",
  "/v1/sse",
  "/api/sse",
];

const server = http.createServer(async (req, res) => {
  console.log("[req]", req.method, req.url);

  if (req.url === "/ping") return ok(res, "pong");
  if (req.url === "/health") return ok(res, "ok");

  if (req.url === "/test-sse") {
    writeSSEHead(res);
    res.write("retry: 1000\n\n");
    const id = setInterval(() => {
      res.write(`event: hello\n`);
      res.write(`data: ${Date.now()}\n\n`);
    }, 1000);
    req.on("close", () => clearInterval(id));
    return;
  }

  // debug: child health
  if (req.url === "/_child/health") {
    try {
      const r = await fetch(`http://127.0.0.1:${INTERNAL_PORT}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      const text = await r.text().catch(() => "");
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true, status: r.status, body: text }));
    } catch (e) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: String(e) }));
    }
  }

  // debug: try common SSE paths on the child
  if (req.url === "/_debug/sse-candidates") {
    const results = [];
    for (const p of CANDIDATE_PATHS) {
      results.push(await probeSSE(p));
    }
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ results }, null, 2));
  }

  // proxy /sse → child at override path (so we can change it without code)
  if (req.url.startsWith("/sse")) {
    const suffix = req.url.slice("/sse".length); // keep any query string
    const target = `http://127.0.0.1:${INTERNAL_PORT}${SSE_OVERRIDE}${suffix}`;
    return proxy.web(req, res, { target });
  }

  // everything else → child as-is
  proxy.web(req, res);
});

server.on("upgrade", (req, socket, head) => {
  proxy.ws(req, socket, head);
});

server.listen(PUBLIC_PORT, "0.0.0.0", () => {
  console.log(
    `Proxy listening on 0.0.0.0:${PUBLIC_PORT} → 127.0.0.1:${INTERNAL_PORT}`
  );
});

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
  child.kill("SIGTERM");
});
