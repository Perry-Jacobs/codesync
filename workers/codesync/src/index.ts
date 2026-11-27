import { hmacBase64, sha256Hex } from "./crypto";
import { integerEnv, roomKeyFromUrl, type Env } from "./env";
import type { RTCIceServer } from "./protocol";

export { RoomDurableObject } from "./room-do";
export { DocumentDurableObject } from "./document-do";
export { RateLimitDurableObject } from "./rate-limit-do";

const ROOM_KEY_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
const MAX_CREATE_BODY = 16 * 1024;

interface CreateRoomBody {
  hostName?: unknown;
  title?: unknown;
  admitMode?: unknown;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      let response: Response;
      if (url.pathname.startsWith("/api/")) {
        const originError = validateOrigin(request, env, url, false);
        if (originError) return withCors(originError, request, env, url);
      }
      if (request.method === "OPTIONS") {
        response = new Response(null, { status: 204 });
      } else if (url.pathname === "/ws")
        response = await handleWebSocket(request, env, url);
      else if (url.pathname === "/api/health")
        response = json({
          ok: true,
          version: "0.1.0",
          durableObjects: true,
          // Media-relay diagnostic: when this is false, browsers can only get
          // a direct P2P path via STUN, which fails across symmetric NATs and
          // carrier CGNAT (the usual cause of one-way or missing audio).
          turn: Boolean((env.TURN_SERVER ?? "").trim()),
        });
      else if (url.pathname === "/api/rtc/config")
        response = await rtcConfig(env);
      else if (url.pathname === "/api/rooms")
        response = await handleRooms(request, env, url);
      else if (url.pathname.startsWith("/api/rooms/")) {
        const key = decodeURIComponent(
          url.pathname.slice("/api/rooms/".length),
        );
        if (!isRoomKey(key))
          response = apiError(400, "BAD_REQUEST", "Invalid room key");
        else response = await roomInfo(env, key);
      } else {
        response = apiError(404, "NOT_FOUND", "Route not found");
      }
      return withCors(response, request, env, url);
    } catch (error) {
      console.error("CodeSync Worker request failed", error);
      return withCors(
        apiError(500, "INTERNAL", "The request could not be completed"),
        request,
        env,
        url,
      );
    }
  },
};

async function handleWebSocket(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  if (request.method !== "GET")
    return apiError(405, "BAD_REQUEST", "Method not allowed");
  const roomKey = roomKeyFromUrl(url);
  if (!roomKey)
    return apiError(400, "BAD_REQUEST", "Missing or invalid room key");
  const originError = validateOrigin(request, env, url, true);
  if (originError) return originError;
  const id = env.ROOM_DO.idFromName(roomKey);
  const stub = env.ROOM_DO.get(id);
  return stub.fetch(request);
}

async function handleRooms(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  if (request.method === "GET") {
    const key = url.searchParams.get("key")?.trim();
    if (!key) return apiError(400, "BAD_REQUEST", "Missing key");
    if (!isRoomKey(key))
      return apiError(400, "BAD_REQUEST", "Invalid room key");
    return roomInfo(env, key);
  }
  if (request.method !== "POST")
    return apiError(405, "BAD_REQUEST", "Method not allowed");
  const originError = validateOrigin(request, env, url, false);
  if (originError) return originError;

  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_CREATE_BODY) {
    return apiError(413, "BAD_REQUEST", "Request body is too large");
  }
  let body: CreateRoomBody;
  try {
    body = (await readBoundedJson(request)) as CreateRoomBody;
  } catch (error) {
    if (error instanceof BodyTooLargeError)
      return apiError(413, "BAD_REQUEST", "Request body is too large");
    return apiError(400, "BAD_REQUEST", "Expected a JSON body");
  }
  const hostName =
    typeof body.hostName === "string" ? body.hostName.trim() : "";
  if (!hostName || hostName.length > 48)
    return apiError(400, "BAD_REQUEST", "hostName is required");
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (title.length > 80)
    return apiError(400, "BAD_REQUEST", "Title is too long");
  const admitMode =
    body.admitMode === "manual"
      ? "manual"
      : body.admitMode === "auto"
        ? "auto"
        : "auto";
  if (
    body.admitMode !== undefined &&
    body.admitMode !== "auto" &&
    body.admitMode !== "manual"
  ) {
    return apiError(400, "BAD_REQUEST", "Invalid admitMode");
  }

  const networkIdentity = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const browserIdentity = request.headers.get("x-codesync-client-id")?.trim();
  const identity = browserIdentity
    ? `browser:${networkIdentity}:${browserIdentity.slice(0, 128)}`
    : `network:${networkIdentity}`;
  const limit = integerEnv(env.ROOM_CREATE_LIMIT, 30);
  const windowSeconds = integerEnv(env.ROOM_CREATE_WINDOW_SECONDS, 600);
  const rate = await checkRateLimit(env, identity, limit, windowSeconds * 1000);
  if (!rate.allowed) {
    const retryAfter = Math.max(
      1,
      Math.ceil((rate.resetAt - Date.now()) / 1000),
    );
    return apiError(
      429,
      "RATE_LIMITED",
      `Too many sessions created. Try again in ${retryAfter} seconds.`,
      {
        "Retry-After": String(retryAfter),
      },
    );
  }

  const roomKey = createRoomKey();
  const id = env.ROOM_DO.idFromName(roomKey);
  const stub = env.ROOM_DO.get(id);
  const response = await stub.fetch("https://room.internal/internal/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: roomKey, hostName, title, admitMode }),
  });
  const created = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    const message =
      typeof created.error === "string"
        ? created.error
        : "Session storage is temporarily unavailable";
    return apiError(
      response.status === 409 ? 409 : 503,
      response.status === 409 ? "BAD_REQUEST" : "UNAVAILABLE",
      message,
    );
  }
  return json(
    {
      roomKey,
      roomId: created.roomId,
      hostToken: created.hostToken,
      hostName: created.hostName,
      title: created.title,
      joinUrl: `${(env.PUBLIC_APP_URL ?? url.origin).replace(/\/$/, "")}/join/${roomKey}`,
    },
    201,
  );
}

async function roomInfo(env: Env, key: string): Promise<Response> {
  const id = env.ROOM_DO.idFromName(key);
  const stub = env.ROOM_DO.get(id);
  const response = await stub.fetch("https://room.internal/internal/info");
  const info = (await response.json()) as Record<string, unknown>;
  if (response.status === 404)
    return apiError(404, "NOT_FOUND", "No session exists for that key");
  if (!response.ok)
    return apiError(
      503,
      "UNAVAILABLE",
      "Session storage is temporarily unavailable",
    );
  return json(info);
}

async function rtcConfig(env: Env): Promise<Response> {
  const iceServers: RTCIceServer[] = [];
  const stunServers = (env.STUN_SERVERS ?? "stun:stun.l.google.com:19302")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (stunServers.length > 0) iceServers.push({ urls: stunServers });
  const turnUrls = (env.TURN_SERVER ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (turnUrls.length > 0) {
    if (env.TURN_SECRET) {
      const ttl = integerEnv(env.TURN_CREDENTIAL_TTL_SECONDS, 3600);
      const expiresAt = Math.floor(Date.now() / 1000) + ttl;
      const username = `${expiresAt}:codesync`;
      const credential = await hmacBase64(env.TURN_SECRET, username);
      iceServers.push({ urls: turnUrls, username, credential });
    } else {
      iceServers.push({
        urls: turnUrls,
        username: env.TURN_USERNAME || undefined,
        credential: env.TURN_PASSWORD || undefined,
      });
    }
  }
  return json({ iceServers, maxBitrateKbps: 900 });
}

function validateOrigin(
  request: Request,
  env: Env,
  url: URL,
  websocket: boolean,
): Response | null {
  const origin = request.headers.get("Origin");
  if (!origin) {
    if (websocket) return apiError(403, "FORBIDDEN", "Origin is required");
    return null;
  }
  const configured = (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim().replace(/\/$/, ""))
    .filter(Boolean);
  const normalized = origin.replace(/\/$/, "");
  const allowed =
    normalized === url.origin.replace(/\/$/, "") ||
    configured.includes("*") ||
    configured.includes(normalized);
  if (!allowed) return apiError(403, "FORBIDDEN", "Origin is not allowed");
  return null;
}

async function checkRateLimit(
  env: Env,
  identity: string,
  limit: number,
  windowMs: number,
): Promise<{ allowed: boolean; resetAt: number }> {
  const id = env.RATE_LIMIT_DO.idFromName("room-creation-rate-limit");
  const stub = env.RATE_LIMIT_DO.get(id);
  const response = await stub.fetch("https://rate-limit.internal/check", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      identity: await sha256Hex(identity),
      limit,
      windowMs,
    }),
  });
  if (!response.ok) throw new Error("Rate-limit service is unavailable");
  return (await response.json()) as { allowed: boolean; resetAt: number };
}

function createRoomKey(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  let key = "zk-";
  for (const byte of bytes)
    key += ROOM_KEY_ALPHABET[byte % ROOM_KEY_ALPHABET.length];
  return key;
}

function isRoomKey(value: string): boolean {
  return /^zk-[A-Za-z0-9_-]{18}$/.test(value);
}

class BodyTooLargeError extends Error {}

async function readBoundedJson(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("INVALID_JSON");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_CREATE_BODY) {
        await reader.cancel();
        throw new BodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function apiError(
  status: number,
  code: string,
  message: string,
  extraHeaders: Record<string, string> = {},
): Response {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extraHeaders,
  });
  return new Response(JSON.stringify({ error: message, code }), {
    status,
    headers,
  });
}

function withCors(
  response: Response,
  request: Request,
  env: Env,
  url: URL,
): Response {
  // A 101 response carries the WebSocket upgrade and cannot be reconstructed
  // with the regular Response constructor (which only accepts 200-599).
  if (response.status === 101) return response;
  const origin = request.headers.get("Origin");
  if (!origin) return response;
  const configured = (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim().replace(/\/$/, ""))
    .filter(Boolean);
  const normalized = origin.replace(/\/$/, "");
  if (
    normalized !== url.origin.replace(/\/$/, "") &&
    !configured.includes("*") &&
    !configured.includes(normalized)
  )
    return response;
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", normalized);
  headers.set("access-control-allow-methods", "GET,POST,OPTIONS");
  headers.set(
    "access-control-allow-headers",
    "content-type, x-codesync-client-id",
  );
  headers.append("vary", "Origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
