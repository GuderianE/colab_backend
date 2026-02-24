# colab_backend

TypeScript Next.js + Node WebSocket backend for multi-user Scratch-like collaboration.

## What This Project Does

- Runs a collaborative websocket backend with workspace isolation.
- Handles auth, presence, cursor sync, element locks, and permission updates.
- Exposes backend status and workspace info over HTTP.

## Tech Stack

- Next.js (minimal service shell)
- Express + Node HTTP server (custom Next server)
- `ws` for real-time websocket messaging
- Platform-provided user IDs (no server-generated identity fallback)

## Quick Start

```bash
npm install
npm run dev
```

Server defaults to port `4000` unless `PORT` is set.

## Scripts

- `npm run dev` - Start custom server in development mode
- `npm run build` - Build Next.js service shell
- `npm start` - Start custom server in production mode

## Endpoints

- `GET /` - Service info page (no collaboration client)
- `GET /health` - Health + active workspace count
- `GET /workspace/:id` - Workspace users and user count

## WebSocket Protocol (Core)

### Authenticate

```json
{
  "type": "auth",
  "token": "<signed-join-ticket>",
  "workspace": "my-workspace-id",
  "username": "Elias",
  "userId": "platform-user-123"
}
```

### Coordinate Updates

```json
{
  "type": "update_coords",
  "coords": { "x": 150, "y": 250 }
}
```

### Element Locking

```json
{
  "type": "request_lock",
  "elementId": "block-123",
  "elementType": "block"
}
```

```json
{
  "type": "release_lock",
  "elementId": "block-123",
  "finalPosition": { "x": 200, "y": 300 }
}
```

### Element Updates

```json
{
  "type": "block_move",
  "blockId": "block-123",
  "position": { "x": 200, "y": 300 }
}
```

```json
{
  "type": "sprite_update",
  "spriteId": "sprite-1",
  "x": 100,
  "y": 140
}
```

### Update Username

```json
{
  "type": "update_username",
  "username": "New Display Name"
}
```

## Join Ticket Verification

- WebSocket auth now validates `token` as a signed JWT join ticket.
- Required claim set: `sub` (platform user id), `workspaceId`, `aud=colab-backend`, unique `jti`, valid `exp`.
- Tickets are replay-protected across identities: a consumed `jti` is only reusable for the same `sub + workspaceId` pair until `exp` (supports reload/reconnect).
- Shared signing secret is read from:
1. `COLAB_JOIN_TOKEN_SECRET`
2. `CRON_SECRET` (fallback)
- In non-production only, a local dev fallback secret is used when neither env var is set.

## Project Structure

- `server.ts` - Next custom server + websocket collaboration backend
- `pages/index.tsx` - Minimal service info page
- `permission-manager-backend.ts` - Backend permission policy and role logic

## Integration Notes for Your Platform

- Keep your own frontend and connect to this server via websocket (`ws://host:port/ws`).
- Authenticate with `type: "auth"` using a short-lived platform-issued join ticket.
- Mirror the message types used in `server.ts` (`request_lock`, `block_move`, etc.).
- Keep Colab headless: UI should live in your Scriptum frontend.

This repository does not ship browser collaboration logic anymore.
All collaboration UI and permission controls must live in Scriptum/Platform.
