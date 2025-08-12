#!/usr/bin/env bash
set -euo pipefail

# Put the child command FIRST so yargs sees a positional.
# Flags for mcp-proxy can still come after.
exec npx -y mcp-proxy npx -y @taazkareem/clickup-mcp-server@0.7.2 \
  --host 0.0.0.0 \
  --port "${PORT:-8080}" \
  --sseEndpoint /sse \
  --streamEndpoint /mcp
