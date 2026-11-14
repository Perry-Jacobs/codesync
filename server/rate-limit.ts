import type { ClientType } from "@/lib/ws-protocol";

/** Token bucket for the global per-socket message budget. */
export class TokenBucket {
  private tokens: number;
  private lastRefill = Date.now();
  private readonly capacity: number;
  private readonly refillPerMs: number;

  constructor(ratePerSecond: number) {
    this.capacity = Math.max(10, Math.floor(ratePerSecond * 1.5));
    this.tokens = this.capacity;
    this.refillPerMs = ratePerSecond / 1000;
  }

  take(cost = 1): boolean {
    const now = Date.now();
    this.tokens = Math.min(
      this.capacity,
      this.tokens + (now - this.lastRefill) * this.refillPerMs,
    );
    this.lastRefill = now;
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}

interface Quota {
  limit: number;
  windowMs: number;
}

/** Hot-path messages get their own tighter budget on top of the global one. */
const QUOTAS: Partial<Record<ClientType, Quota>> = {
  cursor_move: { limit: 30, windowMs: 1000 },
  selection_change: { limit: 12, windowMs: 1000 },
  viewport_change: { limit: 6, windowMs: 1000 },
  yjs_update: { limit: 50, windowMs: 1000 },
  chat_send: { limit: 5, windowMs: 10_000 },
  file_op: { limit: 12, windowMs: 10_000 },
  webrtc_signal: { limit: 40, windowMs: 1000 },
  fs_file_content: { limit: 30, windowMs: 10_000 },
  fs_ack: { limit: 60, windowMs: 10_000 },
};

const QUOTA_LABELS: Partial<Record<ClientType, string>> = {
  cursor_move: "cursor updates",
  selection_change: "selection changes",
  viewport_change: "viewport changes",
  yjs_update: "document updates",
  chat_send: "chat messages",
  file_op: "file operations",
  webrtc_signal: "connection signals",
  fs_file_content: "file content updates",
  fs_ack: "file acknowledgements",
};

/** The configured quota limit for a message type, when it has a hot-path quota. */
export function quotaLimit(type: ClientType): number | undefined {
  return QUOTAS[type]?.limit;
}

/** A user-facing rate-limit message that never exposes the wire message type. */
export function quotaErrorMessage(type: ClientType): string {
  const limit = quotaLimit(type);
  const label = QUOTA_LABELS[type] ?? "messages";
  if (!limit) return `Slow down — you are sending messages too quickly`;
  return `Slow down — you can send ${limit} ${label} at a time`;
}

interface WindowState {
  start: number;
  count: number;
  limit: number;
  windowMs: number;
}

export class QuotaLimiter {
  private readonly windows = new Map<ClientType, WindowState>();

  check(type: ClientType): boolean {
    const quota = QUOTAS[type];
    if (!quota) return true;
    const now = Date.now();
    const existing = this.windows.get(type);
    if (!existing || now - existing.start >= existing.windowMs) {
      this.windows.set(type, { start: now, count: 1, ...quota });
      return true;
    }
    if (existing.count >= existing.limit) return false;
    existing.count += 1;
    return true;
  }
}

/** Atomic fixed-window counter backed by Redis, used for /api/rooms abuse. */
export async function bumpRedisCounter(
  redis: {
    eval(
      script: string,
      numberOfKeys: number,
      ...args: (string | number)[]
    ): Promise<unknown>;
  },
  key: string,
  windowSeconds: number,
): Promise<number> {
  const result = await redis.eval(
    `
      local count = redis.call('INCR', KEYS[1])
      if count == 1 then
        redis.call('EXPIRE', KEYS[1], ARGV[1])
      end
      return count
    `,
    1,
    key,
    windowSeconds,
  );
  return Number(result);
}
