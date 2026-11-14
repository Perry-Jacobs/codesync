import { nanoid } from "nanoid";
import { getRedis, keys } from "@/lib/redis";

export interface FsResponse {
  ok: boolean;
  content?: string;
  mtime?: number;
  error?: string;
}

export interface FsRequestRecord {
  roomId: string;
  requesterSocketId: string | null;
  targetSocketId: string;
  hostParticipantId: string;
  op: string;
}

export type FsBusPayload =
  | {
      kind: "response";
      roomId: string;
      requestId: string;
      response: FsResponse;
    }
  | {
      kind: "cancel";
      roomId: string;
      socketId?: string;
      reason: string;
    };

interface Pending {
  roomId: string;
  requesterSocketId: string | null;
  targetSocketId: string | null;
  resolve: (response: FsResponse) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, Pending>();
const REQUEST_TTL_SECONDS = 30;

export function nextRequestId(): string {
  return `rq_${nanoid(12)}`;
}

/**
 * Registers both the local waiter and shared request metadata. The Redis
 * record lets a host response received by another gateway be validated before
 * it is routed back to the requesting gateway.
 */
export async function createFsRequest(
  record: FsRequestRecord,
  requestId: string,
  timeoutMs = 8000,
): Promise<{ requestId: string; response: Promise<FsResponse> }> {
  const response = new Promise<FsResponse>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      void getRedis().del(keys.fsRequest(requestId));
      resolve({ ok: false, error: "Host did not answer in time" });
    }, timeoutMs);
    pending.set(requestId, {
      roomId: record.roomId,
      requesterSocketId: record.requesterSocketId,
      targetSocketId: record.targetSocketId,
      timer,
      resolve: (response) => {
        clearTimeout(timer);
        pending.delete(requestId);
        void getRedis().del(keys.fsRequest(requestId));
        resolve(response);
      },
    });
  });

  try {
    await getRedis().set(
      keys.fsRequest(requestId),
      JSON.stringify(record),
      "EX",
      REQUEST_TTL_SECONDS,
    );
  } catch (error) {
    const entry = pending.get(requestId);
    if (entry) {
      clearTimeout(entry.timer);
      pending.delete(requestId);
    }
    throw error;
  }
  return { requestId, response };
}

/** Claims a response exactly once after validating the shared request. */
export async function acceptFsResponse(
  requestId: string,
  roomId: string,
  hostParticipantId: string,
  hostSocketId: string,
  response: FsResponse,
): Promise<boolean> {
  const redis = getRedis();
  const raw = await redis.get(keys.fsRequest(requestId));
  if (!raw) {
    console.warn("[fs] response request record missing", { requestId });
    return false;
  }
  let record: FsRequestRecord;
  try {
    record = JSON.parse(raw) as FsRequestRecord;
  } catch {
    console.warn("[fs] response request record invalid", { requestId });
    return false;
  }
  if (
    record.roomId !== roomId ||
    record.hostParticipantId !== hostParticipantId ||
    record.targetSocketId !== hostSocketId
  ) {
    console.warn("[fs] response request record mismatch", {
      requestId,
      expectedRoomId: record.roomId,
      actualRoomId: roomId,
      expectedHostParticipantId: record.hostParticipantId,
      actualHostParticipantId: hostParticipantId,
      expectedSocketId: record.targetSocketId,
      actualSocketId: hostSocketId,
    });
    return false;
  }
  const claimed = await redis.set(
    keys.fsResponse(requestId),
    JSON.stringify(response),
    "EX",
    REQUEST_TTL_SECONDS,
    "NX",
  );
  if (!claimed) {
    console.warn("[fs] response already claimed", { requestId });
    return false;
  }
  await redis.del(keys.fsRequest(requestId));
  return true;
}

export function publishFsResponse(
  roomId: string,
  requestId: string,
  response: FsResponse,
): void {
  const payload: FsBusPayload = {
    kind: "response",
    roomId,
    requestId,
    response,
  };
  void getRedis()
    .publish(keys.fsBus(roomId), JSON.stringify(payload))
    .catch(() => undefined);
}

export function publishFsCancellation(
  roomId: string,
  reason: string,
  socketId?: string,
): void {
  const payload: FsBusPayload = {
    kind: "cancel",
    roomId,
    reason,
    ...(socketId ? { socketId } : {}),
  };
  void getRedis()
    .publish(keys.fsBus(roomId), JSON.stringify(payload))
    .catch(() => undefined);
}

export function resolveFsResponse(
  requestId: string,
  response: FsResponse,
): boolean {
  const entry = pending.get(requestId);
  if (!entry) return false;
  entry.resolve(response);
  return true;
}

export function handleFsBusPayload(payload: FsBusPayload): void {
  if (payload.kind === "response") {
    resolveFsResponse(payload.requestId, payload.response);
    return;
  }
  rejectRoomRequests(payload.roomId, payload.reason, payload.socketId);
}

export function rejectRoomRequests(
  roomId: string,
  reason: string,
  socketId?: string,
): void {
  for (const [requestId, entry] of pending) {
    if (entry.roomId !== roomId) continue;
    if (
      socketId !== undefined &&
      entry.targetSocketId !== socketId &&
      entry.requesterSocketId !== socketId
    ) {
      continue;
    }
    entry.resolve({ ok: false, error: reason });
    pending.delete(requestId);
  }
}
