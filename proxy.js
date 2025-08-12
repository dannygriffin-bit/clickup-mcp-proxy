// proxy.js  — drop-in replacement

import http from "http";
import { spawn } from "child_process";
import httpProxy from "http-proxy";
import fetch from "node-fetch";

const INTERNAL_PORT = 10000;                    // child (MCP) listens here on localhost
const PUBLIC_PORT  = process.env.PORT || 3000;  // Render provides PORT

// ---- start the ClickUp MCP as a child (http+sse capable in 0.7.2) ----
const child = spawn("npx", ["-y", "@taazkareem/clickup-mcp-server@0.7.2"], {
  env: { ...process.env, PORT: String(INTERNAL_PORT) },
  stdio: "inherit",
  shell: false
});

child.on("exit", (code) => {
  console.error("[child] exited with code:", code);
});

// ---- reverse proxy for normal HTTP (not SSE) ----
const proxy = httpProxy.createProxyServer({
  target: `http://127.0.0.1:${INTERNAL_PORT}`,
  changeOrigin: true,
  ws: true
});

proxy.on("error", (err) => {
  console.error("Proxy error:", err.message);
});

// ---- tiny SSE tunnel that strips/sets headers to avoid 431/502 ----
function tunnelSSE(path, req, res) {
  const upstreamReq = http.request(
    {
      host: "127.0.0.1",
      port: INTERNAL_PORT,
      path,
      method: "GET",
      headers: {
        // keep it minimal; upstream will reject huge/forwarded headers
        accept: "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    },
    (upstreamRes) => {
      // forward the stream
      const headers = {
        // preserve content-type and cache headers if present
        "content-type":
          upstreamRes.headers["content-type"] || "text/event-stream",
        "cache-control":
          upstreamRes.headers["cache-control"] || "no-cache",
        connection: "keep-alive",
        "x-accel-buffering": "no", // hint some proxies not to buffer
      };
      res.writeHead(upstreamRes.statusCode || 200, headers);
      upstreamRes.pipe(res);
    }
  );

  upstreamReq.on("error", (e) => {
    console.error("[sse] tunnel error:", e.message);
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "text/plain" });
    }
    res.end("sse tunnel error");
  });

  // nothing to send upstream for SSE GET
  upstreamReq.end();

  // clean up if client disconnects
  req.on("close", () => upstreamReq.destroy());
}

// ---- HTTP server (public) ----
const server = http.createServer(async (req, res) => {
  // quick health
  if (req.url === "/health") {
    res.end("ok");
    return;
  }

  // debug ping
  if (req.url === "/ping") {
    res.end("pong");
    return;
  }

  // internal: check child’s /health
  if (req.url === "/_child/health") {
    try {
      const r = await fetch(`http://127.0.0.1:${INTERNAL_PORT}/health`);
      res.writeHead(r.status, Object.fromEntries(r.headers));
      res.end(await r.text());
    } catch (e) {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end("child not reachable");
    }
    return;
  }

  // internal: try SSE at a given path on the child (e.g. /sse)
  if (req.url?.startsWith("/_child/try-sse")) {
    const url = new URL(req.url, "http://localhost");
    const path = url.searchParams.get("path") || "/sse";
    let ok = false, status = 0, ctype = null, error = null;

    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 4000);

      const r = await fetch(
        `http://127.0.0.1:${INTERNAL_PORT}${path}`,
        {
          headers: { accept: "text/event-stream" },
          signal: controller.signal,
        }
      );

      status = r.status;
      ctype = r.headers.get("content-type");
      ok = status === 200 && ctype && ctype.includes("text/event-stream");
      clearTimeout(t);
    } catch (e) {
      error = String(e);
    }

    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ path, status, ctype, ok, error }, null, 2));
    return;
  }

  // public test page to eyeball SSE from the child
  if (req.url === "/test-sse") {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<!doctype html>
<html><body>
<h3>Child SSE test (/sse)</h3>
<pre id="out"></pre>
<script>
const out = document.getElementById('out');
const es = new EventSource('/sse');
es.onmessage = (e)=>{ out.textContent += e.data + "\\n"; };
es.onerror = ()=>{ out.textContent += "[error]\\n"; };
</script>
</body></html>`);
    return;
  }

  // ---- SSE paths (go through our manual tunnel) ----
  if (req.url === "/sse" || req.url === "/events" || req.url === "/event" || req.url === "/stream") {
    return tunnelSSE(req.url, req, res);
  }

  // everything else -> normal reverse proxy
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

// graceful shutdown
process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
  try { child.kill("SIGTERM"); } catch {}
});
