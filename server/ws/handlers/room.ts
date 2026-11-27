import type { ClientPayloads } from "@/lib/ws-protocol";
import { ROLE_ORDER } from "@/lib/acl";
import {
  claimParticipantSocket,
  enqueueWaiting,
  getEndedMarker,
  getParticipant,
  getRoom,
  getRoomByKey,
  isParticipantPresent,
  listParticipants,
  listWaiting,
  pruneStaleParticipants,
  removeParticipant,
  reserveParticipantSlot,
  reviveRoom,
  scheduleRoomExpiry,
  touchRoom,
  updateParticipant,
} from "../../rooms/repository";
import {
  issueReconnectToken,
  verifyHostToken,
  verifyReconnectToken,
} from "../../rooms/tokens";
import {
  pickColor,
  toWireParticipant,
  type ParticipantRecord,
  type RoomRecord,
} from "../../rooms/types";
import { WsError } from "../../errors";
import { createLogger } from "../../logger";
import type { SocketContext } from "../connection";
import {
  emit,
  findSocket,
  registerSocket,
  roomSocketCount,
  unregisterSocket,
} from "../broadcast";
import { clearParticipant, clearRoomPresence } from "../presence-store";
import { hasDifferentLiveSocket } from "../socket-ownership";
import { buildRoomState, notifyWaiting } from "../state";
import { reconnectRejection } from "../reconnect-policy";

const log = createLogger({ scope: "room" });

/**
 * Two guests who pick the same display name make the People rail and toasts
 * ambiguous. Keep the requested name when it is free and suffix it otherwise,
 * ignoring participants who already left, were removed, or whose tab is gone.
 */
function uniqueDisplayName(
  requested: string,
  taken: readonly string[],
): string {
  const base = requested.trim().slice(0, 48) || "Guest";
  const used = new Set(taken.map((name) => name.trim().toLocaleLowerCase()));
  if (!used.has(base.toLocaleLowerCase())) return base;
  for (let index = 2; index < 1000; index += 1) {
    const suffix = ` (${index})`;
    const candidate = `${base.slice(0, 48 - suffix.length).trimEnd()}${suffix}`;
    if (!used.has(candidate.toLocaleLowerCase())) return candidate;
  }
  return `${base.slice(0, 40)} ${Date.now().toString(36)}`;
}

function activeNames(
  participants: readonly ParticipantRecord[],
  excludeId?: string,
): string[] {
  return participants
    .filter(
      (entry) =>
        entry.id !== excludeId &&
        (entry.state === "ADMITTED" || entry.state === "WAITING") &&
        // A closed tab leaves an ADMITTED record behind until the sweeper
        // prunes it. Reservations should follow live sockets, not ghosts.
        entry.socketId !== null,
    )
    .map((entry) => entry.name);
}

interface AttachOptions {
  announce: "new" | "rejoin" | "silent";
}

async function attach(
  ctx: SocketContext,
  room: RoomRecord,
  participant: ParticipantRecord,
  options: AttachOptions,
): Promise<void> {
  ctx.bind(room.id, participant);
  registerSocket(ctx);
  await reviveRoom(room.id);

  const reconnectToken = await issueReconnectToken(
    participant.id,
    room.id,
    participant.role,
  );
  ctx.send("room_state", await buildRoomState(room, participant));
  ctx.send("admitted", {
    reconnectToken,
    self: toWireParticipant(participant),
  });

  if (options.announce === "new") {
    emit(
      room.id,
      "participant_joined",
      { participant: toWireParticipant(participant) },
      { exceptSocketId: ctx.id },
    );
  } else if (options.announce === "rejoin") {
    emit(
      room.id,
      "participant_updated",
      { participant: toWireParticipant(participant) },
      { exceptSocketId: ctx.id },
    );
  }
}

function evictPreviousSocket(
  roomId: string,
  participant: ParticipantRecord,
  ctx: SocketContext,
): void {
  if (!participant.socketId || participant.socketId === ctx.id) return;
  const previous = findSocket(roomId, participant.socketId);
  if (!previous) return;
  previous.send("error", {
    code: "CONFLICT",
    message: "This session was resumed in another tab or device.",
  });
  previous.unbind();
  previous.close(4009, "Session resumed elsewhere");
}

async function joinAsExisting(
  ctx: SocketContext,
  room: RoomRecord,
  existing: ParticipantRecord,
  data: ClientPayloads["join_room"],
  access: "reconnect" | "host",
): Promise<void> {
  evictPreviousSocket(room.id, existing, ctx);
  // Resuming an identity must keep its current role and grants. The atomic
  // claim also rejects stale credentials, waiting participants, and reconnects
  // into a room that was locked after the initial request check.
  const next = await claimParticipantSocket(
    room.id,
    existing.id,
    ctx.id,
    existing.canSpeak ? data.media.mic : false,
    data.media.cam,
    { allowLocked: access === "host" },
  );
  if (!next) {
    if (access === "reconnect") {
      const currentRoom = await getRoom(room.id);
      if (currentRoom?.status === "locked") {
        throw new WsError("ROOM_LOCKED", "The host locked this session");
      }
    }
    throw new WsError("CONFLICT", "This participant is no longer admitted");
  }
  await attach(ctx, room, next, { announce: "rejoin" });
}

export async function handleJoinRoom(
  ctx: SocketContext,
  data: ClientPayloads["join_room"],
): Promise<void> {
  if (ctx.joined)
    throw new WsError("INVALID_MESSAGE", "Socket already joined a room");

  const room = await getRoomByKey(data.roomKey);
  if (!room) {
    if (await getEndedMarker(data.roomKey)) {
      throw new WsError("ROOM_ENDED", "The host ended this session");
    }
    throw new WsError("ROOM_NOT_FOUND", "No session exists for that key");
  }
  if (room.status === "ended") {
    throw new WsError("ROOM_ENDED", "The host ended this session");
  }

  if (data.reconnectToken) {
    if (room.status === "locked") {
      throw new WsError("ROOM_LOCKED", "The host locked this session");
    }
    const claims = await verifyReconnectToken(data.reconnectToken);
    if (!claims) {
      throw new WsError(
        "UNAUTHENTICATED",
        "This reconnect session is invalid or has expired",
      );
    }
    if (claims.roomId !== room.id) {
      throw new WsError(
        "CONFLICT",
        "This reconnect session belongs to a different room",
      );
    }
    const existing = await getParticipant(room.id, claims.participantId);
    if (!existing) {
      throw new WsError(
        "FORBIDDEN",
        "This participant can no longer rejoin the session",
      );
    }
    const rejection = reconnectRejection(room.status, existing.state);
    if (rejection) {
      throw new WsError(rejection.code, rejection.message);
    }
    await joinAsExisting(ctx, room, existing, data, "reconnect");
    return;
  }

  const isHost = await verifyHostToken(
    room.id,
    room.hostParticipantId,
    data.hostToken,
  );
  if (isHost) {
    const host = await getParticipant(room.id, room.hostParticipantId);
    if (host?.state === "ADMITTED") {
      await joinAsExisting(ctx, room, host, data, "host");
      return;
    }
  }

  if (room.status === "locked") {
    throw new WsError("ROOM_LOCKED", "The host locked this session");
  }

  await pruneStaleParticipants(room.id);
  const existingParticipants = await listParticipants(room.id);
  const admitted = existingParticipants.filter((p) => isParticipantPresent(p));
  if (admitted.length >= room.maxParticipants) {
    throw new WsError(
      "PARTICIPANT_LIMIT",
      `This session is full (${room.maxParticipants} max)`,
    );
  }
  const waitingNow = existingParticipants.filter((p) => p.state === "WAITING");
  if (
    room.admitMode === "manual" &&
    waitingNow.length >= room.maxParticipants
  ) {
    throw new WsError("PARTICIPANT_LIMIT", "The waiting room is full");
  }

  const now = Date.now();
  const waiting = room.admitMode === "manual";
  const role = waiting ? "GUEST" : "VIEWER";
  const participant: ParticipantRecord = {
    id: `p_${crypto.randomUUID().replaceAll("-", "").slice(0, 14)}`,
    name: uniqueDisplayName(
      data.displayName.trim().slice(0, 48) || "Guest",
      activeNames(existingParticipants),
    ),
    role,
    color: pickColor(admitted.length + waitingNow.length),
    state: waiting ? "WAITING" : "ADMITTED",
    canEdit: false,
    canSpeak: false,
    mic: false,
    cam: waiting ? false : data.media.cam,
    screen: false,
    handRaised: false,
    typing: false,
    joinedAt: now,
    socketId: ctx.id,
    lastSeenAt: now,
  };

  const reservation = await reserveParticipantSlot(
    room.id,
    participant,
    room.maxParticipants,
    waiting ? "WAITING" : "ADMITTED",
  );
  if (reservation === "ended" || reservation === "missing") {
    throw new WsError("ROOM_ENDED", "The host ended this session");
  }
  if (reservation === "locked") {
    throw new WsError("ROOM_LOCKED", "The host locked this session");
  }
  if (reservation === "mode_changed") {
    throw new WsError(
      "CONFLICT",
      "The host changed the admission mode; try joining again",
    );
  }
  if (reservation === "limit") {
    throw new WsError(
      "PARTICIPANT_LIMIT",
      waiting
        ? "The waiting room is full"
        : `This session is full (${room.maxParticipants} max)`,
    );
  }
  if (waiting) await enqueueWaiting(room.id, participant.id);

  ctx.bind(room.id, participant);
  registerSocket(ctx);
  await reviveRoom(room.id);
  ctx.send("room_state", await buildRoomState(room, participant));

  if (waiting) {
    await notifyWaiting(room.id);
    log.info("participant waiting", {
      roomId: room.id,
      participantId: participant.id,
    });
    return;
  }

  const reconnectToken = await issueReconnectToken(
    participant.id,
    room.id,
    participant.role,
  );
  ctx.send("admitted", {
    reconnectToken,
    self: toWireParticipant(participant),
  });
  emit(
    room.id,
    "participant_joined",
    { participant: toWireParticipant(participant) },
    { exceptSocketId: ctx.id },
  );
  await touchRoom(room.id);
  log.info("participant joined", {
    roomId: room.id,
    participantId: participant.id,
    role: participant.role,
  });
}

export async function handleLeaveRoom(ctx: SocketContext): Promise<void> {
  await detachSocket(ctx, "left");
  ctx.close(1000, "Left session");
}

/**
 * Cleans up a socket that is going away. Safe to call twice: if another socket
 * has already taken over the participant, the record is left untouched.
 */
export async function detachSocket(
  ctx: SocketContext,
  reason: "left" | "dropped",
): Promise<void> {
  const roomId = ctx.roomId;
  const participant = ctx.participant;
  unregisterSocket(ctx);
  if (!roomId || !participant) return;
  const fresh = await getParticipant(roomId, participant.id);
  if (!fresh) {
    clearParticipant(roomId, participant.id);
    ctx.unbind();
    return;
  }

  if (fresh.state === "WAITING") {
    if (fresh.socketId === ctx.id) {
      clearParticipant(roomId, participant.id);
      await removeParticipant(roomId, participant.id);
      await notifyWaiting(roomId);
    }
    ctx.unbind();
    return;
  }

  // A replacement socket may already own this participant, especially when it
  // connected to a different gateway. A delayed close from the old socket must
  // not erase the replacement's live presence or mark it as left. A null socket
  // ID is not a live replacement, so stale snapshots still need cleanup.
  if (hasDifferentLiveSocket(fresh.socketId, ctx.id)) {
    ctx.unbind();
    return;
  }

  clearParticipant(roomId, participant.id);
  const next = await updateParticipant(
    roomId,
    participant.id,
    {
      socketId: null,
      mic: false,
      cam: false,
      screen: false,
      typing: false,
      handRaised: false,
      state: reason === "left" ? "LEFT" : fresh.state,
      lastSeenAt: Date.now(),
    },
    { requireSocketId: ctx.id },
  );
  if (next) {
    emit(
      roomId,
      "participant_left",
      { participantId: participant.id, reason },
      {},
    );
  }

  ctx.unbind();
  if (roomSocketCount(roomId) === 0) {
    clearRoomPresence(roomId);
    await scheduleRoomExpiry(roomId);
    log.info("room idle, ttl armed", { roomId });
  }
}

export async function roomSummary(roomId: string): Promise<RoomRecord | null> {
  return getRoom(roomId);
}

export async function waitingFor(roomId: string): Promise<ParticipantRecord[]> {
  return listWaiting(roomId);
}

export function sortByRole(
  participants: ParticipantRecord[],
): ParticipantRecord[] {
  return [...participants].sort(
    (a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role],
  );
}
