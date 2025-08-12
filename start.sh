#!/usr/bin/env bash
set -euo pipefail
set -x

# Put the child command FIRST so mcp-proxy sees a positional command.
exec npx -y mcp-proxy npx -y @taazkareem/clickup-mcp-server@0.7.2 \
  --host 0.0.0.0 \
  --port "${PORT:-8080}" \
  --sseEndpoint /sse \
  --streamEndpoint /mcp
