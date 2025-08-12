# Base image with Node (for your ClickUp MCP server) + pip (to install the bridge)
FROM node:20-slim

# Install Python pip and the SSE bridge (sparfenyuk/mcp-proxy)
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3-pip ca-certificates curl \
 && pip3 install --no-cache-dir mcp-proxy \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

# Render will set PORT; we’ll bind the bridge to 0.0.0.0:$PORT
ENV HOST=0.0.0.0
WORKDIR /app

# Command:
#  - mcp-proxy listens on $PORT and exposes /sse
#  - it spawns your ClickUp MCP as a stdio child using npx
#  - --pass-environment passes CLICKUP_* env vars through to the child
CMD ["bash", "-lc", "mcp-proxy --host ${HOST} --port ${PORT} --allow-origin '*' --pass-environment npx -y @taazkareem/clickup-mcp-server@0.7.2"]
