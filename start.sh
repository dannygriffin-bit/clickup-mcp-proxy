#!/usr/bin/env bash
set -euo pipefail

exec npx -y mcp-proxy \
  --host 0.0.0.0 \
  --port "${PORT:-8080}" \
  --sseEndpoint /sse \
  --streamEndpoint /mcp \
  -- npx -y @taazkareem/clickup-mcp-server@0.7.2
