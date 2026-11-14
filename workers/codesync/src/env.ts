export interface Env {
  ROOM_DO: DurableObjectNamespace;
  DOCUMENT_DO: DurableObjectNamespace;
  RATE_LIMIT_DO: DurableObjectNamespace;
  ALLOWED_ORIGINS?: string;
  MAX_PARTICIPANTS?: string;
  ROOM_CREATE_LIMIT?: string;
  ROOM_CREATE_WINDOW_SECONDS?: string;
  STUN_SERVERS?: string;
  TURN_SERVER?: string;
  TURN_SECRET?: string;
  TURN_USERNAME?: string;
  TURN_PASSWORD?: string;
  TURN_CREDENTIAL_TTL_SECONDS?: string;
  JWT_SECRET?: string;
  PUBLIC_APP_URL?: string;
}

export function integerEnv(
  value: string | undefined,
  fallback: number,
): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function roomKeyFromUrl(url: URL): string | null {
  const value = url.searchParams.get("room")?.trim() ?? "";
  return /^zk-[A-Za-z0-9_-]{18}$/.test(value) ? value : null;
}
