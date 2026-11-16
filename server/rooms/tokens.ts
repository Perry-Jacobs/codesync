import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { nanoid } from "nanoid";
import { SignJWT, jwtVerify } from "jose";
import { getEnv } from "@/lib/env";
import { getRedis, keys } from "@/lib/redis";
import type { Role } from "@/lib/ws-protocol";

const ISSUER = "codesync";
const AUDIENCE = "codesync:reconnect";
const RECONNECT_TTL = "15m";

function secretKey(): Uint8Array {
  return new TextEncoder().encode(getEnv().JWT_SECRET);
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function newId(prefix: "r" | "p" | "f" | "m"): string {
  return `${prefix}_${nanoid(14)}`;
}

export function generateHostToken(): string {
  return randomBytes(32).toString("base64url");
}

export async function storeHostToken(
  roomId: string,
  participantId: string,
  token: string,
): Promise<void> {
  const redis = getRedis();
  await redis.set(
    keys.host(roomId),
    JSON.stringify({ participantId, tokenHash: sha256(token) }),
    "EX",
    getEnv().roomTtlSeconds * 4,
  );
}

/**
 * Host tokens are durable bearer credentials bound to the participant that
 * currently owns the host role. They must stay valid for the life of the room:
 * a host who reloads after losing the tab's reconnect token still needs to be
 * able to reclaim the role. transfer_host rotates the stored token, so an old
 * credential cannot be used after ownership changes.
 */
export async function verifyHostToken(
  roomId: string,
  participantId: string,
  token: string | undefined,
): Promise<boolean> {
  if (!token) return false;
  const stored = await getRedis().get(keys.host(roomId));
  if (!stored) return false;
  try {
    const record = JSON.parse(stored) as {
      participantId?: unknown;
      tokenHash?: unknown;
    };
    return (
      record.participantId === participantId &&
      typeof record.tokenHash === "string" &&
      safeEqual(record.tokenHash, sha256(token))
    );
  } catch {
    return false;
  }
}

export async function invalidateHostToken(roomId: string): Promise<void> {
  await getRedis().del(keys.host(roomId));
}

export async function rotateHostToken(
  roomId: string,
  participantId: string,
): Promise<string> {
  const token = generateHostToken();
  await storeHostToken(roomId, participantId, token);
  return token;
}

export interface ReconnectClaims {
  participantId: string;
  roomId: string;
  role: Role;
  jti: string;
}

export async function issueReconnectToken(
  participantId: string,
  roomId: string,
  role: Role,
): Promise<string> {
  const jti = nanoid(18);
  // Kept alive for the token lifetime so reconnect survives a brief network drop.
  await getRedis().set(
    keys.reconnect(jti),
    JSON.stringify({ roomId, participantId }),
    "EX",
    15 * 60,
  );
  return new SignJWT({ roomId, role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(participantId)
    .setJti(jti)
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime(RECONNECT_TTL)
    .sign(secretKey());
}

export async function verifyReconnectToken(
  token: string,
): Promise<ReconnectClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(), {
      algorithms: ["HS256"],
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    const participantId = payload.sub;
    const roomId = typeof payload.roomId === "string" ? payload.roomId : null;
    const role =
      typeof payload.role === "string" ? (payload.role as Role) : null;
    const jti = payload.jti;
    if (!participantId || !roomId || !role || !jti) return null;
    // Kept alive for the token lifetime so reconnect survives a brief network
    // drop, including a drop before the replacement token reaches the client.
    const known = await getRedis().get(keys.reconnect(jti));
    if (!known) return null;
    let stored: { roomId?: unknown; participantId?: unknown };
    try {
      stored = JSON.parse(known) as {
        roomId?: unknown;
        participantId?: unknown;
      };
    } catch {
      return null;
    }
    if (stored.participantId !== participantId || stored.roomId !== roomId)
      return null;
    return { participantId, roomId, role, jti };
  } catch {
    return null;
  }
}
