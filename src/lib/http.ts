import { NextResponse } from "next/server";

export const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, max-age=0, must-revalidate",
  Pragma: "no-cache",
} as const;

export function json<T>(body: T, init?: ResponseInit): NextResponse<T> {
  return NextResponse.json(body, {
    ...init,
    headers: { ...NO_STORE_HEADERS, ...(init?.headers ?? {}) },
  });
}

export function apiError(
  status: number,
  code: string,
  error: string,
  headers?: HeadersInit,
): NextResponse<{ error: string; code: string }> {
  return json({ error, code }, { status, headers });
}

/**
 * Client identity for room-creation rate limiting. The custom server overwrites
 * x-codesync-client-ip with the peer address, so callers cannot spoof it.
 * Forwarding headers are only trusted when the deployment explicitly opts in.
 */
export function clientIdentity(request: Request): string {
  // When explicitly trusting a reverse proxy, use the proxy-provided client
  // identity first. The proxy must overwrite (not append to) forwarding
  // headers so clients cannot spoof them.
  if (process.env.TRUST_PROXY_HEADERS === "true") {
    const forwarded = request.headers.get("x-forwarded-for");
    if (forwarded) return forwarded.split(",")[0]?.trim() || "unknown";
    const realIp = request.headers.get("x-real-ip");
    if (realIp) return realIp;
  }
  const direct = request.headers.get("x-codesync-client-ip");
  if (direct) return direct;
  return "local";
}
