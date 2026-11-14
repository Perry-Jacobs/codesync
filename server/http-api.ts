import type { IncomingMessage } from "node:http";
import {
  createRoomSchema,
  type CreateRoomResponse,
  type RoomInfoResponse,
} from "@/lib/api-types";
import { getEnv } from "@/lib/env";
import { getRedis } from "@/lib/redis";
import { bumpRedisCounter } from "./rate-limit";
import { createRoom } from "./rooms/repository";
import { roomInfoByKey } from "./rooms/info";

const NO_STORE_HEADERS = {
  "cache-control": "no-store, max-age=0, must-revalidate",
  pragma: "no-cache",
} as const;

export async function handleLegacyHttpApi(
  request: IncomingMessage,
): Promise<Response | null> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const path = url.pathname;

  if (path === "/api/health" && request.method === "GET") {
    return json({ ok: true, version: "0.1.0", durableObjects: false });
  }
  if (path === "/api/rtc/config" && request.method === "GET") {
    return json(rtcConfig());
  }
  if (path === "/api/rooms" && request.method === "GET") {
    const key = url.searchParams.get("key")?.trim();
    if (!key) return apiError(400, "BAD_REQUEST", "Missing key");
    return roomInfoResponse(key);
  }
  if (path === "/api/rooms" && request.method === "POST") {
    return createRoomResponse(request);
  }
  if (path.startsWith("/api/rooms/") && request.method === "GET") {
    const key = decodeURIComponent(path.slice("/api/rooms/".length));
    if (!key) return apiError(400, "BAD_REQUEST", "Missing key");
    return roomInfoResponse(key);
  }
  return null;
}

async function createRoomResponse(request: IncomingMessage): Promise<Response> {
  let body: unknown;
  try {
    body = JSON.parse(await readBody(request));
  } catch {
    return apiError(400, "BAD_REQUEST", "Expected a JSON body");
  }
  const parsed = createRoomSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(400, "BAD_REQUEST", "Invalid room details");
  }

  const env = getEnv();
  const identity = clientIdentity(request, env.TRUST_PROXY_HEADERS === "true");
  const counterKey = `http:room-create:${identity}`;
  const count = await bumpRedisCounter(
    getRedis(),
    counterKey,
    env.ROOM_CREATE_WINDOW_SECONDS,
  );
  if (count > env.ROOM_CREATE_LIMIT) {
    const retryAfter = Math.max(1, await getRedis().ttl(counterKey));
    return apiError(
      429,
      "RATE_LIMITED",
      `Session creation limit reached. Try again in ${formatRetryAfter(retryAfter)}.`,
      { "retry-after": String(retryAfter) },
    );
  }

  const created = await createRoom(parsed.data);
  const response: CreateRoomResponse = {
    roomKey: created.room.key,
    roomId: created.room.id,
    hostToken: created.hostToken,
    hostName: created.host.name,
    title: created.room.title,
    joinUrl: `${env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "")}/join/${created.room.key}`,
  };
  return json(response, 201);
}

async function roomInfoResponse(key: string): Promise<Response> {
  const info = await roomInfoByKey(key);
  if (info === null) {
    return apiError(404, "NOT_FOUND", "No session exists for that key");
  }
  if (info === "ended") {
    return apiError(410, "GONE", "The host ended this session");
  }
  return json(info satisfies RoomInfoResponse);
}

function rtcConfig(): { iceServers: RTCIceServer[]; maxBitrateKbps: number } {
  const env = getEnv();
  const iceServers: RTCIceServer[] = [];
  if (env.stunServers.length > 0) iceServers.push({ urls: env.stunServers });
  if (env.TURN_SERVER) {
    iceServers.push({
      urls: env.TURN_SERVER,
      username: env.TURN_USERNAME || undefined,
      credential: env.TURN_PASSWORD || undefined,
    });
  }
  return { iceServers, maxBitrateKbps: 900 };
}

function clientIdentity(request: IncomingMessage, trustProxy: boolean): string {
  let networkIdentity = request.socket.remoteAddress ?? "unknown";
  if (trustProxy) {
    const forwarded = request.headers["x-forwarded-for"];
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    if (first) networkIdentity = first.split(",", 1)[0].trim();
  }

  const header = request.headers["x-codesync-client-id"];
  const browserIdentity = Array.isArray(header) ? header[0] : header;
  if (browserIdentity?.trim()) {
    return `browser:${networkIdentity}:${browserIdentity.trim().slice(0, 128)}`;
  }
  return `network:${networkIdentity}`;
}

function formatRetryAfter(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 16 * 1024) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function apiError(
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return json({ error: message, code }, status, headers);
}

function json(
  value: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...NO_STORE_HEADERS,
      ...extraHeaders,
    },
  });
}
