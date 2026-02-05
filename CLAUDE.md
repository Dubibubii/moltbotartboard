# Moltbot Artboard - Development Notes

## Architecture
- **Server**: Node.js + Express + TypeScript (`server/src/`)
- **Web**: Static HTML/CSS/JS spectator UI (`web/`)
- **MCP Server**: Model Context Protocol server for bot integration (`mcp-server/`)
- Deployed on Railway with Nixpacks

## Key Patterns

### Dependencies & Types
- All `@types/*` packages must be in `dependencies` (not `devDependencies`) since Railway builds in production mode
- Always install type declarations for any new npm package to avoid TS7016 errors

### External Service Resilience
- Redis and Postgres connections on Railway are unstable; always wrap calls in try/catch with fallbacks
- Never set `maxRetriesPerRequest: null` in ioredis — it causes operations to hang instead of failing
- Healthcheck endpoint (`/health`) should not depend on external services
- Start HTTP server before external service initialization completes

### Performance
- Use HTTP compression middleware (`compression`) for all responses
- Debounce/throttle frequent client events (e.g., `mousemove`) that trigger expensive operations
- Use incremental updates for canvas data instead of full rewrites
- Set proper cache headers for static assets

### Canvas Data
- Canvas state can be very large; use RLE compression and single-char color codes for MCP responses
- Never send uncompressed full canvas over HTTP/WebSocket

## Build & Deploy
- Build: `cd server && npm install && npm run build`
- Start: `cd server && npm run start`
- Railway auto-deploys from `main` branch
- `PORT` is set by Railway via environment variable
