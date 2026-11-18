import type {
  ClientPayloads,
  FileMeta,
  WorkspaceMode,
} from "@/lib/ws-protocol";
import { hasCapability } from "@/lib/acl";
import { languageFromPath } from "@/utils/language";
import {
  getFileById,
  getFileByPath,
  getParticipant,
  listFiles,
  removeFile,
  renameFiles,
  replaceFiles,
  updateRoom,
  upsertFile,
} from "../../rooms/repository";
import { newId } from "../../rooms/tokens";
import type { ParticipantRecord, RoomRecord } from "../../rooms/types";
import { WsError } from "../../errors";
import { createLogger } from "../../logger";
import {
  clearFileSubscriptions,
  clearRoomFileSubscriptions,
  emit,
  sendToParticipant,
} from "../broadcast";
import type { SocketContext } from "../connection";
import { openFile, requireRoom } from "./code";
import {
  acceptFsResponse,
  createFsRequest,
  nextRequestId,
  publishFsResponse,
  type FsResponse,
} from "../../fs/pending";
import { clearRoomDocs, deleteDoc } from "../../yjs/store";
import { cancelWritebacks } from "../../fs/writeback";
import { forgetFile, clearRoomPresence } from "../presence-store";
import {
  moveWorkspacePath,
  workspaceMoveConflict,
  workspacePathConflict,
} from "@/lib/workspace-paths";

const log = createLogger({ scope: "fs" });
const MAX_FILES = 600;

async function hostRecord(room: RoomRecord): Promise<ParticipantRecord> {
  const host = await getParticipant(room.id, room.hostParticipantId);
  if (!host?.socketId) {
    throw new WsError(
      "FS_NOT_CONNECTED",
      "The host is offline or has not connected a folder",
    );
  }
  return host;
}

async function requestHost(
  room: RoomRecord,
  op: "read" | "write" | "delete" | "mkdir" | "create" | "rename",
  path: string,
  extra: { fileId?: string; toPath?: string; content?: string } = {},
  requesterSocketId: string | null = null,
): Promise<FsResponse> {
  const host = await hostRecord(room);
  const requestId = nextRequestId();
  const request = await createFsRequest(
    {
      roomId: room.id,
      requesterSocketId,
      targetSocketId: host.socketId as string,
      hostParticipantId: host.id,
      op,
    },
    requestId,
    8000,
  );
  sendToParticipant(room.id, host.id, "fs_request", {
    requestId,
    op,
    path,
    fileId: extra.fileId,
    toPath: extra.toPath,
    content: extra.content,
  });
  return request.response;
}

function requireWriteAccess(participant: ParticipantRecord): void {
  if (!hasCapability(participant, "file_write")) {
    throw new WsError("FORBIDDEN", "The host hasn't granted edit access");
  }
}

export async function handleFileOp(
  ctx: SocketContext,
  data: ClientPayloads["file_op"],
): Promise<void> {
  const { room, participant } = await requireRoom(ctx);

  if (data.op === "open") {
    await openFile(ctx, data);
    return;
  }

  requireWriteAccess(participant);
  const files = await listFiles(room.id);

  if (data.op === "create" || data.op === "mkdir") {
    if (files.length >= MAX_FILES)
      throw new WsError("CONFLICT", "Workspace file limit reached");
    const conflict = workspacePathConflict(files, data.path, {
      allowImplicitDirectory: data.op === "mkdir",
    });
    if (conflict) throw new WsError("CONFLICT", conflict);
    if (room.workspaceMode === "local-fs") {
      const ack = await requestHost(
        room,
        data.op === "mkdir" ? "mkdir" : "create",
        data.path,
        {},
        ctx.id,
      );
      if (!ack.ok)
        throw new WsError(
          "CONFLICT",
          ack.error ?? "The host could not create that entry",
        );
    }
    const kind = data.op === "mkdir" ? "dir" : "file";
    const meta: FileMeta = {
      fileId: newId("f"),
      path: data.path,
      kind,
      size: 0,
      mtime: Date.now(),
      lang: kind === "file" ? languageFromPath(data.path) : "plaintext",
    };
    await upsertFile(room.id, meta);
    emit(room.id, "file_changed", { op: data.op, path: meta.path, meta }, {});
    log.info("entry created", {
      roomId: room.id,
      path: meta.path,
      op: data.op,
    });
    return;
  }

  const file = data.fileId
    ? await getFileById(room.id, data.fileId)
    : await getFileByPath(room.id, data.path);
  if (!file) throw new WsError("CONFLICT", "Entry not found");

  if (data.op === "rename" || data.op === "move") {
    const toPath = data.toPath?.trim();
    if (!toPath)
      throw new WsError("INVALID_MESSAGE", "Missing destination path");
    if (toPath === file.path) return;
    const conflict = workspaceMoveConflict(files, file.path, toPath, file.kind);
    if (conflict) throw new WsError("CONFLICT", conflict);
    if (room.workspaceMode === "local-fs") {
      const ack = await requestHost(
        room,
        "rename",
        file.path,
        { toPath },
        ctx.id,
      );
      if (!ack.ok)
        throw new WsError(
          "CONFLICT",
          ack.error ?? "The host could not rename that entry",
        );
    }

    const affected = files.filter(
      (entry) =>
        entry.path === file.path ||
        (file.kind === "dir" && entry.path.startsWith(`${file.path}/`)),
    );
    const movedEntries = affected.map((entry) => {
      const nextPath = moveWorkspacePath(entry.path, file.path, toPath);
      const moved: FileMeta = {
        ...entry,
        path: nextPath,
        lang: entry.kind === "file" ? languageFromPath(nextPath) : "plaintext",
        mtime: Date.now(),
      };
      return { from: entry.path, file: moved };
    });
    await renameFiles(room.id, movedEntries);
    const moved = movedEntries.find((entry) => entry.from === file.path)?.file;
    if (!moved) throw new WsError("INTERNAL", "Could not move workspace entry");
    emit(
      room.id,
      "file_changed",
      { op: data.op, path: file.path, toPath, meta: moved },
      {},
    );
    return;
  }

  if (data.op === "delete") {
    if (room.workspaceMode === "local-fs") {
      const ack = await requestHost(room, "delete", file.path, {}, ctx.id);
      if (!ack.ok)
        throw new WsError(
          "CONFLICT",
          ack.error ?? "The host could not delete that entry",
        );
    }
    const doomed =
      file.kind === "dir"
        ? files.filter(
            (entry) =>
              entry.path === file.path ||
              entry.path.startsWith(`${file.path}/`),
          )
        : [file];
    for (const entry of doomed) {
      clearFileSubscriptions(room.id, entry.fileId);
      forgetFile(room.id, entry.fileId);
      if (entry.kind === "file") await deleteDoc(room.id, entry.fileId);
      await removeFile(room.id, entry.path);
    }
    emit(room.id, "file_changed", { op: "delete", path: file.path }, {});
    return;
  }

  throw new WsError("INVALID_MESSAGE", "Unsupported file operation");
}

export async function handleBridgeAttach(
  ctx: SocketContext,
  data: ClientPayloads["fs_bridge_attach"],
): Promise<void> {
  const { room, participant } = await requireRoom(ctx);
  if (room.hostParticipantId !== participant.id) {
    throw new WsError("FORBIDDEN", "Only the host can connect a local folder");
  }

  if (!data.connected) {
    clearRoomFileSubscriptions(room.id);
    const previous = await listFiles(room.id);
    const nextMode: WorkspaceMode = "virtual";
    await updateRoom(room.id, { workspaceMode: nextMode, rootName: null });
    cancelWritebacks(room.id);
    await clearRoomDocs(room.id);
    await replaceFiles(room.id, []);
    emit(
      room.id,
      "workspace_reset",
      {
        files: [],
        rootName: null,
        mode: nextMode,
      },
      {},
    );
    log.info("workspace detached", {
      roomId: room.id,
      removedEntries: previous.length,
    });
    return;
  }

  const snapshot = data.snapshot.slice(0, MAX_FILES);
  // A folder attach starts a new workspace generation. Fresh file ids keep
  // stale clients from merging their previous Yjs history into the documents
  // that are about to be seeded from disk (which would duplicate file text).
  const nextFiles: FileMeta[] = snapshot.map((entry) => {
    return {
      fileId: newId("f"),
      path: entry.path,
      kind: entry.kind,
      size: entry.size,
      mtime: entry.mtime,
      lang: entry.kind === "file" ? languageFromPath(entry.path) : "plaintext",
    };
  });

  // Disk becomes the source of truth: invalidate subscriptions, drop cached
  // Yjs docs, and reseed lazily.
  clearRoomFileSubscriptions(room.id);
  clearRoomPresence(room.id);
  await clearRoomDocs(room.id);
  cancelWritebacks(room.id);
  await replaceFiles(room.id, nextFiles);
  await updateRoom(room.id, {
    workspaceMode: "local-fs",
    rootName: data.rootName.slice(0, 120) || "Local folder",
  });

  emit(
    room.id,
    "workspace_reset",
    { files: nextFiles, rootName: data.rootName, mode: "local-fs" },
    {},
  );
  log.info("workspace attached", { roomId: room.id, files: nextFiles.length });
}

export async function handleFsFileContent(
  ctx: SocketContext,
  data: ClientPayloads["fs_file_content"],
): Promise<void> {
  const { room, participant } = await requireRoom(ctx);
  if (room.hostParticipantId !== participant.id) {
    throw new WsError(
      "FORBIDDEN",
      "Only the host may answer filesystem requests",
    );
  }
  const response: FsResponse = {
    ok: true,
    content: data.content,
    mtime: data.mtime,
  };
  const accepted = await acceptFsResponse(
    data.requestId,
    room.id,
    participant.id,
    ctx.id,
    response,
  );
  if (!accepted) {
    log.warn("unmatched read response", { requestId: data.requestId });
    return;
  }
  publishFsResponse(room.id, data.requestId, response);
  const file = await getFileById(room.id, data.fileId);
  if (file) {
    await upsertFile(room.id, {
      ...file,
      size: data.content.length,
      mtime: data.mtime,
    });
  }
}

export async function handleFsAck(
  ctx: SocketContext,
  data: ClientPayloads["fs_ack"],
): Promise<void> {
  const { room, participant } = await requireRoom(ctx);
  if (room.hostParticipantId !== participant.id) {
    throw new WsError(
      "FORBIDDEN",
      "Only the host may answer filesystem requests",
    );
  }
  const response: FsResponse = {
    ok: data.ok,
    error: data.error,
  };
  const accepted = await acceptFsResponse(
    data.requestId,
    room.id,
    participant.id,
    ctx.id,
    response,
  );
  if (!accepted) {
    log.warn("unmatched fs ack", { requestId: data.requestId });
    return;
  }
  publishFsResponse(room.id, data.requestId, response);

  if (data.ok && data.fileId) {
    const file = await getFileById(room.id, data.fileId);
    if (file) await upsertFile(room.id, { ...file, mtime: Date.now() });
  }
}
