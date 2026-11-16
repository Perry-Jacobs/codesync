import type { ClientPayloads } from "@/lib/ws-protocol";
import { hasCapability } from "@/lib/acl";
import {
  getFileById,
  getFileByPath,
  getParticipant,
  getRoom,
} from "../../rooms/repository";
import type { FileMeta } from "@/lib/ws-protocol";
import type { ParticipantRecord, RoomRecord } from "../../rooms/types";
import { WsError } from "../../errors";
import {
  emit,
  fileSubscribers,
  sendToParticipant,
  subscribeFile,
  unsubscribeFile,
} from "../broadcast";
import type { SocketContext } from "../connection";
import {
  acquireDoc,
  applyUpdate,
  deleteDoc,
  encodeDiff,
  encodeSnapshot,
  seedDoc,
} from "../../yjs/store";
import { createFsRequest, nextRequestId } from "../../fs/pending";
import { scheduleWriteback } from "../../fs/writeback";
import { createLogger } from "../../logger";
import { presenceForFile, recordPresence } from "../presence-store";

const log = createLogger({ scope: "presence" });

interface SessionContext {
  room: RoomRecord;
  participant: ParticipantRecord;
}

/** Async guard so two sockets opening the same cold file don't race the seed. */
const fileLocks = new Map<string, Promise<unknown>>();

async function withFileLock<T>(
  key: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = fileLocks.get(key) ?? Promise.resolve();
  const run = previous.then(task, task);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  fileLocks.set(key, tail);
  try {
    return await run;
  } finally {
    if (fileLocks.get(key) === tail) fileLocks.delete(key);
  }
}

export async function requireRoom(ctx: SocketContext): Promise<SessionContext> {
  if (!ctx.roomId || !ctx.participant)
    throw new WsError("UNAUTHENTICATED", "Join a room first");
  const room = await getRoom(ctx.roomId);
  if (!room) throw new WsError("ROOM_NOT_FOUND", "Room no longer exists");
  if (room.status === "ended")
    throw new WsError("ROOM_ENDED", "The session has ended");
  const participant = await getParticipant(room.id, ctx.participant.id);
  if (!participant || participant.state !== "ADMITTED")
    throw new WsError("NOT_ADMITTED", "You are not admitted to this room");
  if (participant.socketId !== ctx.id)
    throw new WsError("FORBIDDEN", "This connection is no longer authorized");
  ctx.participant = participant;
  return { room, participant };
}

async function resolveFile(
  roomId: string,
  fileId: string | undefined,
  path: string,
): Promise<FileMeta> {
  const file = fileId
    ? await getFileById(roomId, fileId)
    : await getFileByPath(roomId, path);
  if (!file || file.kind !== "file")
    throw new WsError("CONFLICT", "File not found in this workspace");
  return file;
}

async function seedFromDisk(
  room: RoomRecord,
  file: FileMeta,
  ctx: SocketContext,
): Promise<void> {
  const host = await getParticipant(room.id, room.hostParticipantId);
  if (!host?.socketId) {
    throw new WsError(
      "FS_NOT_CONNECTED",
      "The host has not connected a local folder",
    );
  }
  const requestId = nextRequestId();
  const request = await createFsRequest(
    {
      roomId: room.id,
      requesterSocketId: ctx.id,
      targetSocketId: host.socketId,
      hostParticipantId: host.id,
      op: "read",
    },
    requestId,
    8000,
  );
  sendToParticipant(room.id, host.id, "fs_request", {
    requestId,
    op: "read",
    fileId: file.fileId,
    path: file.path,
  });
  const result = await request.response;
  if (!result.ok || typeof result.content !== "string") {
    throw new WsError(
      "FS_TIMEOUT",
      result.error ?? "Could not read the file from the host",
    );
  }
  await seedDoc(room.id, file.fileId, result.content, ctx.id);
}

async function deliverSnapshot(
  ctx: SocketContext,
  room: RoomRecord,
  file: FileMeta,
): Promise<void> {
  const snapshot = encodeSnapshot(room.id, file.fileId);
  if (!snapshot) throw new WsError("INTERNAL", "Document unavailable");
  ctx.send("yjs_sync", {
    fileId: file.fileId,
    update: Buffer.from(snapshot).toString("base64"),
    kind: "snapshot",
  });
}

/**
 * Sends the last known cursor, selection and viewport of every other editor in
 * this file. Without it a late joiner sees no collaborator cursor until that
 * collaborator happens to move again.
 */
function replayFilePresence(
  ctx: SocketContext,
  room: RoomRecord,
  fileId: string,
): void {
  for (const presence of presenceForFile(
    room.id,
    fileId,
    ctx.participant?.id ?? "",
  )) {
    if (presence.cursor) {
      ctx.send("cursor", {
        participantId: presence.participantId,
        fileId,
        line: presence.cursor.line,
        column: presence.cursor.column,
        topLine: presence.cursor.topLine,
      });
    }
    if (presence.selection) {
      ctx.send("selection", {
        participantId: presence.participantId,
        fileId,
        ranges: presence.selection,
      });
    }
    if (presence.viewport !== undefined) {
      ctx.send("viewport", {
        participantId: presence.participantId,
        fileId,
        topLine: presence.viewport,
      });
    }
  }
}

/**
 * Acquire a document and, for a cold local-fs file, seed it from the host's
 * disk. A failed read must not leave an empty document behind: otherwise the
 * next open sees `created === false` and serves empty content forever.
 */
async function acquireSeededDoc(
  room: RoomRecord,
  file: FileMeta,
  ctx: SocketContext,
): Promise<void> {
  const { created } = await acquireDoc(room.id, file.fileId, ctx.id);
  if (!created || room.workspaceMode !== "local-fs") return;
  try {
    await seedFromDisk(room, file, ctx);
  } catch (error) {
    await deleteDoc(room.id, file.fileId);
    throw error;
  }
}

export async function openFile(
  ctx: SocketContext,
  data: Pick<ClientPayloads["file_op"], "fileId" | "path">,
): Promise<void> {
  const { room } = await requireRoom(ctx);
  // Opening a file is a read operation. Read-only participants may follow the
  // document; writes remain gated by handleYjsUpdate.
  const file = await resolveFile(room.id, data.fileId, data.path);
  const createdSubscription = subscribeFile(ctx, file.fileId);

  try {
    await withFileLock(`${room.id}:${file.fileId}`, async () => {
      await acquireSeededDoc(room, file, ctx);
      await deliverSnapshot(ctx, room, file);
    });
  } catch (error) {
    if (createdSubscription) unsubscribeFile(ctx, file.fileId);
    throw error;
  }
  replayFilePresence(ctx, room, file.fileId);
}

export async function handleFileSyncRequest(
  ctx: SocketContext,
  data: ClientPayloads["yjs_sync_request"],
): Promise<void> {
  const { room } = await requireRoom(ctx);
  // Read-only participants can request the current document for a file they
  // opened. They never reach the write path below.
  const file = await getFileById(room.id, data.fileId);
  if (!file || file.kind !== "file")
    throw new WsError("CONFLICT", "File not found");
  const createdSubscription = subscribeFile(ctx, file.fileId);

  try {
    await withFileLock(`${room.id}:${file.fileId}`, async () => {
      await acquireSeededDoc(room, file, ctx);
      const stateVector = data.stateVector
        ? new Uint8Array(Buffer.from(data.stateVector, "base64"))
        : undefined;
      const update = encodeDiff(room.id, file.fileId, stateVector);
      if (!update) throw new WsError("INTERNAL", "Document unavailable");
      ctx.send("yjs_sync", {
        fileId: file.fileId,
        update: Buffer.from(update).toString("base64"),
        kind: stateVector ? "diff" : "snapshot",
      });
    });
  } catch (error) {
    if (createdSubscription) unsubscribeFile(ctx, file.fileId);
    throw error;
  }
  replayFilePresence(ctx, room, file.fileId);
}

export async function handleYjsUpdate(
  ctx: SocketContext,
  data: ClientPayloads["yjs_update"],
): Promise<void> {
  const { room, participant } = await requireRoom(ctx);
  if (!hasCapability(participant, "edit_code")) {
    throw new WsError("FORBIDDEN", "The host hasn't granted edit access");
  }
  const file = await getFileById(room.id, data.fileId);
  if (!file || file.kind !== "file")
    throw new WsError("CONFLICT", "File not found");
  const createdSubscription = subscribeFile(ctx, file.fileId);

  try {
    await withFileLock(`${room.id}:${file.fileId}`, async () => {
      // A local-fs document must be seeded from the host's disk before any
      // client update is applied. Otherwise a cold update can replace the
      // original file with an empty Yjs document.
      await acquireSeededDoc(room, file, ctx);
      const bytes = Buffer.from(data.update, "base64");
      if (bytes.length === 0)
        throw new WsError("INVALID_MESSAGE", "Empty update");
      if (bytes.length > 300_000)
        throw new WsError("PAYLOAD_TOO_LARGE", "Update too large");

      const applied = applyUpdate(
        room.id,
        file.fileId,
        new Uint8Array(bytes),
        ctx.id,
      );
      if (!applied) throw new WsError("CONFLICT", "Update rejected");
    });
  } catch (error) {
    if (createdSubscription) unsubscribeFile(ctx, file.fileId);
    throw error;
  }

  emit(
    room.id,
    "yjs_sync",
    { fileId: file.fileId, update: data.update, kind: "diff" },
    {
      fileId: data.fileId,
      exceptSocketId: ctx.id,
    },
  );
  markTyping(ctx);
  if (room.workspaceMode === "local-fs")
    scheduleWriteback(room.id, file.fileId);
}

const typingTimers = new Map<string, ReturnType<typeof setTimeout>>();
const typingStartedAt = new Map<string, number>();

function markTyping(ctx: SocketContext): void {
  const participant = ctx.participant;
  if (!participant) return;
  const now = Date.now();
  const last = typingStartedAt.get(participant.id) ?? 0;
  if (now - last > 1500) {
    typingStartedAt.set(participant.id, now);
    if (!participant.typing) {
      participant.typing = true;
      emit(ctx.roomId ?? "", "participant_updated", {
        participant: { ...participant, typing: true },
      });
    }
  }
  const existing = typingTimers.get(participant.id);
  if (existing) clearTimeout(existing);
  typingTimers.set(
    participant.id,
    setTimeout(() => {
      typingTimers.delete(participant.id);
      if (!ctx.participant || ctx.participant.id !== participant.id) return;
      ctx.participant.typing = false;
      emit(ctx.roomId ?? "", "participant_updated", {
        participant: { ...ctx.participant, typing: false },
      });
    }, 2600),
  );
}

export async function handleCursorMove(
  ctx: SocketContext,
  data: ClientPayloads["cursor_move"],
): Promise<void> {
  const { room, participant } = await requireRoom(ctx);
  // Presence is an editing affordance. Read-only viewers should not advertise
  // a cursor, selection or viewport that editors would then see.
  if (!hasCapability(participant, "edit_code")) return;
  const file = await getFileById(room.id, data.fileId);
  if (!file || file.kind !== "file") {
    throw new WsError("CONFLICT", "File not found in this workspace");
  }
  subscribeFile(ctx, data.fileId);
  recordPresence(room.id, participant.id, data.fileId, {
    kind: "cursor",
    line: data.line,
    column: data.column,
    topLine: data.topLine,
  });
  log.debug("cursor received", {
    participantId: participant.id,
    canEdit: participant.canEdit,
    role: participant.role,
    fileId: data.fileId,
    line: data.line,
    subscribers: fileSubscribers(room.id, data.fileId)
      .map((socket) => socket.id)
      .join(","),
  });
  emit(
    room.id,
    "cursor",
    {
      participantId: participant.id,
      fileId: data.fileId,
      line: data.line,
      column: data.column,
      topLine: data.topLine,
    },
    { fileId: data.fileId, exceptSocketId: ctx.id },
  );
}

export async function handleSelectionChange(
  ctx: SocketContext,
  data: ClientPayloads["selection_change"],
): Promise<void> {
  const { room, participant } = await requireRoom(ctx);
  if (!hasCapability(participant, "edit_code")) return;
  const file = await getFileById(room.id, data.fileId);
  if (!file || file.kind !== "file") {
    throw new WsError("CONFLICT", "File not found in this workspace");
  }
  subscribeFile(ctx, data.fileId);
  recordPresence(room.id, participant.id, data.fileId, {
    kind: "selection",
    ranges: data.ranges,
  });
  emit(
    room.id,
    "selection",
    { participantId: participant.id, fileId: data.fileId, ranges: data.ranges },
    { fileId: data.fileId, exceptSocketId: ctx.id },
  );
}

export async function handleViewportChange(
  ctx: SocketContext,
  data: ClientPayloads["viewport_change"],
): Promise<void> {
  const { room, participant } = await requireRoom(ctx);
  if (!hasCapability(participant, "edit_code")) return;
  const file = await getFileById(room.id, data.fileId);
  if (!file || file.kind !== "file") {
    throw new WsError("CONFLICT", "File not found in this workspace");
  }
  subscribeFile(ctx, file.fileId);
  recordPresence(room.id, participant.id, file.fileId, {
    kind: "viewport",
    topLine: data.topLine,
  });
  emit(
    room.id,
    "viewport",
    {
      participantId: participant.id,
      fileId: data.fileId,
      topLine: data.topLine,
    },
    { fileId: data.fileId, exceptSocketId: ctx.id },
  );
}
