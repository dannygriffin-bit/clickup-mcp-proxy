// proxy.js  — minimal, resilient, and Render-friendly
import http from "http";
import httpProxy from "http-proxy";
import { spawn } from "child_process";
import fetch from "node-fetch";

// Render gives us PORT. Do NOT override it. Fallback only for local dev.
const PUBLIC_PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

// We'll run the child SSE bridge on a localhost-only port.
const INTERNAL_PORT = 3333;

// Basic env sanity
console.log("ENV sanity:", {
  HAS_API_KEY: !!process.env.CLICKUP_API_KEY,
  HAS_TEAM_ID: !!process.env.CLICKUP_TEAM_ID,
  PUBLIC_PORT: String(PUBLIC_PORT),
});

// --- 1) Start our public HTTP server right away (so Render sees an open port) ---
const proxy = httpProxy.createProxyServer({
  target: `http://127.0.0.1:${INTERNAL_PORT}`,
  changeOrigin: true,
  ws: true,
});

proxy.on("error", (err, req, res) => {
  console.error("Proxy error:", err.message);
  if (!res.headersSent) {
    res.writeHead(502, { "content-type": "text/plain" });
  }
  res.end("bad gateway");
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  // Lightweight health + ping
  if (url.pathname === "/ping") {
    res.end("pong");
    return;
  }
  if (url.pathname === "/health") {
    // Return OK unconditionally so Render's router stays happy
    res.end("ok");
    return;
  }

  // Debug helper: try hitting a candidate SSE path on the child quickly
  if (url.pathname === "/_child/try-sse") {
    const path = url.searchParams.get("path") || "/sse";
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 1500);
      const r = await fetch(`http://127.0.0.1:${INTERNAL_PORT}${path}`, {
        signal: ctl.signal,
        headers: { accept: "text/event-stream" },
      }).catch((e) => ({ ok: false, status: 0, headers: null, _err: e }));
      clearTimeout(t);

      const ctype = r && r.headers ? r.headers.get("content-type") : null;
      const out = {
        path,
        status: r?.status ?? 0,
        ctype,
        ok: !!r?.ok,
        ...(r && r._err ? { error: String(r._err) } : {}),
      };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(out, null, 2));
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(e) }, null, 2));
    }
    return;
  }

  // Optional manual test page
  if (url.pathname === "/test-sse") {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<!doctype html>
<html><body>
  <h3>Child SSE test (/sse)</h3>
  <pre id="out">[connecting...]</pre>
  <script>
    const out = document.getElementById('out');
    const ev = new EventSource('/sse');
    ev.onmessage = (m) => { out.textContent += "\\n" + m.data; };
    ev.onerror = (e) => { out.textContent += "\\n[error]"; };
  </script>
</body></html>`);
    return;
  }

  // Anything under /sse or /mcp goes to the child bridge
  if (url.pathname.startsWith("/sse") || url.pathname.startsWith("/mcp")) {
    proxy.web(req, res);
    return;
  }

  // Friendly default page
  if (url.pathname === "/") {
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end(
      [
        "ClickUp MCP Proxy",
        "",
        "Health:  /health  → ok",
        "Ping:    /ping    → pong",
        "Child:   /_child/try-sse?path=/sse (expect 200, content-type: text/event-stream)",
        "Manual:  /test-sse (should stream)",
        "",
        "SSE endpoint (for ChatGPT):   /sse",
        "HTTP stream (if used):        /mcp",
      ].join("\n")
    );
    return;
  }

  // Default 404
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

server.on("upgrade", (req, socket, head) => {
  // Not required for SSE, but harmless
  proxy.ws(req, socket, head);
});

server.listen(PUBLIC_PORT, "0.0.0.0", () => {
  console.log(
    `Public server listening on 0.0.0.0:${PUBLIC_PORT} → child at 127.0.0.1:${INTERNAL_PORT}`
  );
});

// --- 2) Spawn the child SSE bridge (mcp-proxy) which wraps the ClickUp MCP server (stdio) ---
function spawnBridge() {
  // mcp-proxy exposes /sse (and /mcp) on INTERNAL_PORT,
  // and wraps a stdio server that we pass after the "--".
  const args = [
    "-y",
    "mcp-proxy",
    "--port",
    String(INTERNAL_PORT),
    "--sseEndpoint",
    "/sse",
    "--", // everything after this goes to the wrapped command
    "npx",
    "-y",
    "@taazkareem/clickup-mcp-server@0.7.2",
  ];

  console.log("[child] starting mcp-proxy → clickup-mcp-server (stdio) …");

  const child = spawn("npx", args, {
    env: {
      ...process.env,
      // Make sure the ClickUp server sees your creds:
      CLICKUP_API_KEY: process.env.CLICKUP_API_KEY || "",
      CLICKUP_TEAM_ID: process.env.CLICKUP_TEAM_ID || "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (d) => process.stdout.write(`[child] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[child] ${d}`));

  child.on("exit", (code) => {
    console.error("[child] exited with code:", code);
    // simple backoff restart
    setTimeout(spawnBridge, 2000);
  });
}

spawnBridge();

// --- 3) Graceful shutdown ---
process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
