import { nanoid } from "nanoid";
import {
  PROTOCOL_VERSION,
  type ServerMessage,
  type ServerPayloads,
  type ServerType,
} from "@/lib/ws-protocol";
import { getRedis, getSubscriber, keys } from "@/lib/redis";
import type { SocketContext } from "./connection";
import type { ParticipantRecord } from "../rooms/types";
import { hasCapability } from "@/lib/acl";
import { applyRemoteRoomMessage } from "./remote-presence";
import { createLogger } from "../logger";
import { applyUpdate, releaseDoc } from "../yjs/store";
import { handleFsBusPayload, type FsBusPayload } from "../fs/pending";

import {
  addFileSubscription as addSubscription,
  clearFileSubscriptions as clearSubscriptions,
  removeFileSubscription as removeSubscription,
  removeSocketSubscriptions,
} from "./file-subscriptions";

const log = createLogger({ scope: "bus" });
const INSTANCE_ID = `i_${nanoid(10)}`;

const roomSockets = new Map<string, Map<string, SocketContext>>();
const fileSubscriptions = new Map<string, Map<string, Set<string>>>();

export interface BroadcastOptions {
  exceptSocketId?: string;
  targetParticipantId?: string;
  fileId?: string;
  requireEdit?: boolean;
}

interface BusPayload {
  origin: string;
  roomId: string;
  message: ServerMessage;
  options: BroadcastOptions;
}

function toMessage<K extends ServerType>(
  type: K,
  data: ServerPayloads[K],
): ServerMessage {
  return {
    v: PROTOCOL_VERSION,
    id: `m_${nanoid(12)}`,
    type,
    ts: Date.now(),
    data,
  } as ServerMessage;
}

export function registerSocket(ctx: SocketContext): void {
  if (!ctx.roomId) return;
  let sockets = roomSockets.get(ctx.roomId);
  if (!sockets) {
    sockets = new Map();
    roomSockets.set(ctx.roomId, sockets);
  }
  sockets.set(ctx.id, ctx);
}

function releaseSocketSubscriptions(roomId: string, socketId: string): void {
  for (const fileId of removeSocketSubscriptions(
    fileSubscriptions,
    roomId,
    socketId,
  )) {
    // Each socket owns one document reference. Release it even when other
    // subscribers remain connected.
    releaseDoc(roomId, fileId, socketId);
  }
}

export function unregisterSocket(ctx: SocketContext): void {
  if (!ctx.roomId) return;
  const sockets = roomSockets.get(ctx.roomId);
  sockets?.delete(ctx.id);
  if (sockets && sockets.size === 0) roomSockets.delete(ctx.roomId);
  releaseSocketSubscriptions(ctx.roomId, ctx.id);
}

export function roomSocketCount(roomId: string): number {
  return roomSockets.get(roomId)?.size ?? 0;
}

export function findSocket(
  roomId: string,
  socketId: string,
): SocketContext | undefined {
  return roomSockets.get(roomId)?.get(socketId);
}

/** Keeps the live socket's cached ACL record in sync with Redis. */
export function refreshSocketParticipant(
  roomId: string,
  participant: ParticipantRecord,
): void {
  const sockets = roomSockets.get(roomId);
  if (!sockets) return;
  for (const socket of sockets.values()) {
    if (socket.participant?.id === participant.id)
      socket.participant = participant;
  }
}

export function closeRoomSockets(
  roomId: string,
  code: number,
  reason: string,
): void {
  const sockets = roomSockets.get(roomId);
  if (!sockets) return;
  for (const socket of sockets.values()) {
    socket.unbind();
    socket.close(code, reason);
  }
  roomSockets.delete(roomId);
  const files = fileSubscriptions.get(roomId);
  if (files) {
    for (const [fileId, subscribers] of files) {
      for (const socketId of subscribers) releaseDoc(roomId, fileId, socketId);
    }
  }
  fileSubscriptions.delete(roomId);
}

export function subscribeFile(ctx: SocketContext, fileId: string): boolean {
  if (!ctx.roomId) return false;
  return addSubscription(fileSubscriptions, ctx.roomId, fileId, ctx.id);
}

export function unsubscribeFile(ctx: SocketContext, fileId: string): void {
  if (!ctx.roomId) return;
  if (removeSubscription(fileSubscriptions, ctx.roomId, fileId, ctx.id)) {
    releaseDoc(ctx.roomId, fileId, ctx.id);
  }
}

export function clearFileSubscriptions(roomId: string, fileId: string): void {
  for (const socketId of clearSubscriptions(
    fileSubscriptions,
    roomId,
    fileId,
  )) {
    releaseDoc(roomId, fileId, socketId);
  }
}

export function clearRoomFileSubscriptions(roomId: string): void {
  const sockets = roomSockets.get(roomId);
  if (!sockets) return;
  for (const socket of sockets.values()) {
    for (const fileId of fileSubscriptions.get(roomId)?.keys() ?? []) {
      unsubscribeFile(socket, fileId);
    }
  }
}

export function clearParticipantFileSubscriptions(
  roomId: string,
  participantId: string,
): void {
  const sockets = roomSockets.get(roomId);
  if (!sockets) return;
  for (const socket of sockets.values()) {
    if (socket.participant?.id !== participantId) continue;
    for (const fileId of fileSubscriptions.get(roomId)?.keys() ?? []) {
      unsubscribeFile(socket, fileId);
    }
  }
}

export function fileSubscribers(
  roomId: string,
  fileId: string,
): SocketContext[] {
  const ids = fileSubscriptions.get(roomId)?.get(fileId);
  const sockets = roomSockets.get(roomId);
  if (!ids || !sockets) return [];
  const result: SocketContext[] = [];
  for (const id of ids) {
    const socket = sockets.get(id);
    if (socket) result.push(socket);
  }
  return result;
}

export function sendToParticipant<K extends ServerType>(
  roomId: string,
  participantId: string,
  type: K,
  data: ServerPayloads[K],
): void {
  emit(roomId, type, data, { targetParticipantId: participantId });
}

export function sendToSocket<K extends ServerType>(
  ctx: SocketContext,
  type: K,
  data: ServerPayloads[K],
): void {
  ctx.send(type, data);
}

function deliverLocal(payload: BusPayload): void {
  const { message, options } = payload;
  const roomId = roomIdOf(message);
  if (!roomId) return;
  const sockets = roomSockets.get(roomId);
  if (!sockets) return;

  const fileSubs = options.fileId
    ? fileSubscriptions.get(roomId)?.get(options.fileId)
    : null;

  for (const socket of sockets.values()) {
    // Waiting participants may receive their own admission/error responses, but
    // they must not observe live room chat, files, presence, or workspace data.
    if (socket.participant?.state !== "ADMITTED") continue;
    if (options.exceptSocketId && socket.id === options.exceptSocketId)
      continue;
    if (
      options.targetParticipantId &&
      socket.participant?.id !== options.targetParticipantId
    ) {
      continue;
    }
    if (options.fileId && !fileSubs?.has(socket.id)) continue;
    if (
      options.requireEdit &&
      socket.participant &&
      !hasCapability(socket.participant, "edit_code")
    ) {
      // Host-backed folder content must never reach read-only participants,
      // including subscribers connected to another gateway.
      continue;
    }
    socket.sendMessage(message);
  }
}

/**
 * The room id lives on the local envelope generated by emit(); targeted bus
 * messages are always delivered through emit(), never through raw sendMessage.
 */
const messageRoom = new WeakMap<ServerMessage, string>();

function roomIdOf(message: ServerMessage): string | undefined {
  return messageRoom.get(message);
}

export function emit<K extends ServerType>(
  roomId: string,
  type: K,
  data: ServerPayloads[K],
  options: BroadcastOptions = {},
): void {
  const message = toMessage(type, data);
  messageRoom.set(message, roomId);
  deliverLocal({ origin: INSTANCE_ID, roomId, message, options });
  publish({ origin: INSTANCE_ID, roomId, message, options });
}

function publish(payload: BusPayload): void {
  const roomId = roomIdOf(payload.message);
  if (!roomId) return;
  const channel = keys.bus(roomId);
  // Publish on the command connection: the subscriber is in subscribe mode and
  // cannot issue PUBLISH.
  void getRedis()
    .publish(channel, JSON.stringify(payload))
    .catch((error: unknown) =>
      log.warn("publish failed", { error: String(error) }),
    );
}

let busReady = false;

export async function initBus(): Promise<void> {
  if (busReady) return;
  busReady = true;
  const subscriber = getSubscriber();
  await subscriber.psubscribe(keys.busPattern(), keys.fsBusPattern());
  subscriber.on(
    "pmessage",
    (pattern: string, _channel: string, raw: string) => {
      try {
        if (pattern === keys.fsBusPattern()) {
          const payload = JSON.parse(raw) as FsBusPayload;
          handleFsBusPayload(payload);
          return;
        }
        const payload = JSON.parse(raw) as BusPayload;
        if (payload.origin === INSTANCE_ID) return;
        if (!payload.roomId || !payload.message) return;
        messageRoom.set(payload.message, payload.roomId);
        const cleanup = applyRemoteRoomMessage(
          payload.roomId,
          payload.message,
          roomSockets.get(payload.roomId)?.values() ?? [],
        );
        if (cleanup.clearFileSubscriptions && cleanup.participantIdToClear) {
          clearParticipantFileSubscriptions(
            payload.roomId,
            cleanup.participantIdToClear,
          );
        }
        // Keep this gateway's server-side Yjs document current when another
        // gateway accepts an edit. The same CRDT update is also forwarded to
        // subscribed browsers, but read-only clients may never echo it back.
        if (
          payload.message.type === "yjs_sync" &&
          payload.message.data.kind === "diff"
        ) {
          const bytes = Buffer.from(payload.message.data.update, "base64");
          if (bytes.length > 0) {
            applyUpdate(
              payload.roomId,
              payload.message.data.fileId,
              new Uint8Array(bytes),
              "redis-bus",
            );
          }
        }
        deliverLocal(payload);
      } catch (error) {
        log.warn("bad bus payload", { error: String(error) });
      }
    },
  );
}

export async function shutdownBus(): Promise<void> {
  if (!busReady) return;
  busReady = false;
  await getSubscriber().punsubscribe(keys.busPattern(), keys.fsBusPattern());
  roomSockets.clear();
  fileSubscriptions.clear();
}
