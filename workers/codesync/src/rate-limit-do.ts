interface RateLimitRequest {
  identity?: unknown;
  limit?: unknown;
  windowMs?: unknown;
}

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

interface RateLimitState {
  entries: Record<string, RateLimitEntry>;
}

const STATE_KEY = "room-creation-rate-limits";
const MAX_TRACKED_IDENTITIES = 5_000;

export class RateLimitDurableObject {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    if (
      request.method !== "POST" ||
      new URL(request.url).pathname !== "/check"
    ) {
      return json({ error: "Not found" }, 404);
    }

    const body = (await request.json()) as RateLimitRequest;
    if (
      typeof body.identity !== "string" ||
      !body.identity ||
      typeof body.limit !== "number" ||
      !Number.isSafeInteger(body.limit) ||
      body.limit < 1 ||
      typeof body.windowMs !== "number" ||
      !Number.isSafeInteger(body.windowMs) ||
      body.windowMs < 1
    ) {
      return json({ error: "Invalid rate-limit request" }, 400);
    }

    const now = Date.now();
    const stored = await this.state.storage.get<RateLimitState>(STATE_KEY);
    const entries = stored?.entries ?? {};
    const current = entries[body.identity];
    const entry =
      !current || current.resetAt <= now
        ? { count: 1, resetAt: now + body.windowMs }
        : { count: current.count + 1, resetAt: current.resetAt };

    entries[body.identity] = entry;

    const expired = Object.entries(entries).filter(
      ([, value]) => value.resetAt <= now,
    );
    for (const [identity] of expired) delete entries[identity];
    const trackedCount = Object.keys(entries).length;
    if (trackedCount > MAX_TRACKED_IDENTITIES) {
      const oldest = Object.entries(entries).sort(
        ([, left], [, right]) => left.resetAt - right.resetAt,
      );
      const overflow = trackedCount - MAX_TRACKED_IDENTITIES;
      for (const [identity] of oldest.slice(0, overflow)) {
        delete entries[identity];
      }
    }

    await this.state.storage.put(STATE_KEY, { entries });
    return json({
      allowed: entry.count <= body.limit,
      resetAt: entry.resetAt,
    });
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
