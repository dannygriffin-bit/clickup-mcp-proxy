// proxy.js
import { spawn } from "child_process";

const PORT = process.env.PORT || "10000";

// We run the official MCP HTTP/SSE bridge ("mcp-proxy") and tell it
// to spawn the ClickUp MCP server (stdio) as the child process.
const args = [
  "mcp-proxy",
  "--port", PORT,
  "--sseEndpoint", "/sse",
  "--streamEndpoint", "/mcp",
  "--",                         // everything after this is for the child
  "npx", "-y", "@taazkareem/clickup-mcp-server@0.7.2"
];

console.log("[runner] starting:", ["npx", ...args].join(" "));

const child = spawn("npx", args, {
  stdio: "inherit",
  shell: false,
  env: process.env
});

child.on("exit", (code) => {
  console.error("[runner] mcp-proxy exited with code:", code);
  // Let Render restart us if it ever dies
  process.exit(code ?? 1);
});

process.on("SIGTERM", () => {
  try { child.kill("SIGTERM"); } catch {}
  process.exit(0);
});
