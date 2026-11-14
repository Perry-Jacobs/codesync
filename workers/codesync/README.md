# CodeSync Cloudflare backend

This directory contains the production backend for CodeSync:

- `RoomDurableObject`: one room per Durable Object. It owns participants,
  admission, permissions, host transfer, chat, file metadata, presence,
  WebRTC signaling, the browser filesystem bridge, and room lifecycle.
- `DocumentDurableObject`: one collaborative Yjs document per room file. It
  stores the CRDT snapshot in Durable Object Storage and serves snapshot/diff
  updates.
- `src/index.ts`: HTTP room API, health endpoint, TURN credentials, CORS and
  WebSocket upgrade routing.

Redis, Redis Pub/Sub, and the Lua scripts are not used by this backend. Each
room's mutations are serialized by its Durable Object.

## Local development

From this directory:

```bash
npm install
npm run check
npm run dev
```

The default local URL is `http://localhost:8787`. The API Worker and its local
Durable Object simulator run together.

For the complete frontend/backend loop, start this backend first, then from
the repository root:

```bash
NEXT_PUBLIC_API_URL=http://localhost:8787 \
NEXT_PUBLIC_WS_URL=ws://localhost:8787/ws \
CODE_SYNC_API_ORIGIN=http://localhost:8787 \
npm run dev
```

The browser can call the API Worker directly when `NEXT_PUBLIC_API_URL` is set.
The Next.js proxy routes remain useful when the frontend and backend use
different origins without exposing the backend URL to the browser.

## Create and deploy the Worker

Authenticate Wrangler:

```bash
npx wrangler login
```

Create the Durable Object namespaces on the first deployment and review the
migration in `wrangler.jsonc`:

```bash
npx wrangler deploy
```

Set production configuration as Worker secrets or variables:

```bash
npx wrangler secret put TURN_SECRET
```

Recommended variables:

```text
ALLOWED_ORIGINS=https://codesync-web.example.workers.dev
PUBLIC_APP_URL=https://codesync-web.example.workers.dev
MAX_PARTICIPANTS=8
ROOM_CREATE_LIMIT=30
ROOM_CREATE_WINDOW_SECONDS=600
STUN_SERVERS=stun:stun.l.google.com:19302
TURN_SERVER=turn:turn.example.com:3478?transport=udp
```

`ALLOWED_ORIGINS` is a comma-separated allowlist. Do not use `*` for a
production deployment. `TURN_SECRET` is optional; when present, the Worker
issues short-lived HMAC credentials and never exposes the secret to browsers.

Room creation is limited per browser installation and network identity. The
browser identifier is stored in `localStorage` and is not a secret. The default
allows 30 room creations per 10 minutes; requests that omit the identifier use
the network identity instead.

## Free-tier notes

The Workers Free plan and Durable Objects have request, storage, and CPU
quotas. They are suitable for occasional study sessions, but no free hosting
plan is guaranteed to be unlimited. Durable Objects also keep a room pinned to
one Cloudflare location until it is evicted, so collaborators may have slightly
higher cross-region latency than the old multi-gateway Redis design.

## Migration notes

The browser WebSocket URL includes the room key:

```text
wss://codesync-api.example.workers.dev/ws?room=zk-xxxxxxxxxxxxxxxxxx
```

Cloudflare requires the room key at upgrade time so the request can be routed
to the correct Durable Object. The existing `join_room` message still performs
host-token/reconnect-token authentication and admission.
