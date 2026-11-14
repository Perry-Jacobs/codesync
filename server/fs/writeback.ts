import {
  getParticipant,
  getFileById,
  getRoom,
  listFiles,
} from "../rooms/repository";
import { sendToParticipant } from "../ws/broadcast";
import { readPlainText } from "../yjs/store";
import { createLogger } from "../logger";
import { createFsRequest, nextRequestId } from "./pending";

const log = createLogger({ scope: "writeback" });
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const fileWriteQueues = new Map<string, Promise<unknown>>();
const DEBOUNCE_MS = 1200;
const MAX_CONTENT = 400_000;

export interface WorkspaceWriteFailure {
  path: string;
  error: string;
}

export interface WorkspaceFlushResult {
  status: "success" | "partial" | "empty" | "failed";
  total: number;
  saved: number;
  failed: number;
  failures: WorkspaceWriteFailure[];
}

/** Debounced "guest typed -> host writes to disk" bridge. */
export function scheduleWriteback(
  roomId: string,
  fileId: string,
  delay = DEBOUNCE_MS,
): void {
  const key = `${roomId}:${fileId}`;
  if (timers.has(key)) return;
  const timer = setTimeout(() => {
    timers.delete(key);
    void writeNow(roomId, fileId);
  }, delay);
  timers.set(key, timer);
}

interface WriteNowResult {
  ok: boolean;
  path: string;
  error?: string;
}

async function writeFileNow(
  roomId: string,
  fileId: string,
): Promise<WriteNowResult> {
  const room = await getRoom(roomId);
  if (!room || room.workspaceMode !== "local-fs" || room.status === "ended") {
    return {
      ok: false,
      path: fileId,
      error: "The local workspace is no longer available",
    };
  }

  const file = await getFileById(roomId, fileId);
  if (!file)
    return { ok: false, path: fileId, error: "The file no longer exists" };

  const content = readPlainText(roomId, fileId);
  if (content === null) {
    return {
      ok: false,
      path: file.path,
      error: "The file has no loaded content",
    };
  }
  if (content.length > MAX_CONTENT) {
    log.warn("file too large to write back", {
      roomId,
      fileId,
      size: content.length,
    });
    return {
      ok: false,
      path: file.path,
      error: "The file is too large to save",
    };
  }

  const host = await getParticipant(roomId, room.hostParticipantId);
  if (!host?.socketId) {
    return {
      ok: false,
      path: file.path,
      error: "The host folder is disconnected",
    };
  }

  const requestId = nextRequestId();
  const request = await createFsRequest(
    {
      roomId,
      requesterSocketId: null,
      targetSocketId: host.socketId,
      hostParticipantId: host.id,
      op: "write",
    },
    requestId,
    6000,
  );
  sendToParticipant(room.id, host.id, "fs_request", {
    requestId,
    op: "write",
    fileId,
    path: file.path,
    content,
  });
  const result = await request.response;
  if (!result.ok) {
    const error = result.error ?? "The host did not confirm the disk write";
    log.warn("disk write failed", { roomId, fileId, error });
    return { ok: false, path: file.path, error };
  }
  return { ok: true, path: file.path };
}

/** Prevents a manual save and debounced writeback from racing on one path. */
function writeNow(roomId: string, fileId: string): Promise<WriteNowResult> {
  const key = `${roomId}:${fileId}`;
  const previous = fileWriteQueues.get(key) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() => writeFileNow(roomId, fileId));
  const queued = next.finally(() => {
    if (fileWriteQueues.get(key) === queued) fileWriteQueues.delete(key);
  });
  fileWriteQueues.set(key, queued);
  return next;
}

/** Writes every currently loaded document to the host's disk. */
export async function flushWorkspaceToDisk(
  roomId: string,
): Promise<WorkspaceFlushResult> {
  const room = await getRoom(roomId);
  if (!room || room.workspaceMode !== "local-fs" || room.status === "ended") {
    return {
      status: "failed",
      total: 0,
      saved: 0,
      failed: 0,
      failures: [],
    };
  }

  const files = await listFiles(roomId);
  const loadedFiles = files.filter(
    (file) =>
      file.kind === "file" && readPlainText(roomId, file.fileId) !== null,
  );
  if (loadedFiles.length === 0) {
    return { status: "empty", total: 0, saved: 0, failed: 0, failures: [] };
  }

  const results = await Promise.all(
    loadedFiles.map((file) => writeNow(roomId, file.fileId)),
  );
  const failures = results
    .filter((result) => !result.ok)
    .map((result) => ({
      path: result.path,
      error: result.error ?? "Unknown error",
    }));
  const saved = results.length - failures.length;
  const status =
    failures.length === 0 ? "success" : saved > 0 ? "partial" : "failed";
  return {
    status,
    total: results.length,
    saved,
    failed: failures.length,
    failures,
  };
}

export function flushWritebacks(roomId: string): void {
  for (const [key, timer] of timers) {
    if (!key.startsWith(`${roomId}:`)) continue;
    clearTimeout(timer);
    timers.delete(key);
    const fileId = key.slice(roomId.length + 1);
    void writeNow(roomId, fileId);
  }
}

export function cancelWritebacks(roomId: string): void {
  for (const [key, timer] of timers) {
    if (!key.startsWith(`${roomId}:`)) continue;
    clearTimeout(timer);
    timers.delete(key);
  }
}
