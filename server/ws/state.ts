import { hasCapability, ROLE_ORDER } from "@/lib/acl";
import type {
  Participant,
  RoomSnapshot,
  ServerPayloads,
} from "@/lib/ws-protocol";
import {
  listChat,
  listFiles,
  listParticipants,
  listWaiting,
} from "../rooms/repository";
import type { ParticipantRecord, RoomRecord } from "../rooms/types";
import { toWireParticipant } from "../rooms/types";
import { sendToParticipant } from "./broadcast";

export function toRoomSnapshot(room: RoomRecord): RoomSnapshot {
  return {
    id: room.id,
    key: room.key,
    title: room.title,
    status: room.status,
    admitMode: room.admitMode,
    hostParticipantId: room.hostParticipantId,
    allowGuestScreenShare: room.allowGuestScreenShare,
    maxParticipants: room.maxParticipants,
    workspaceMode: room.workspaceMode,
    rootName: room.rootName,
    createdAt: room.createdAt,
  };
}

function sortParticipants(records: ParticipantRecord[]): Participant[] {
  return records.map(toWireParticipant).sort((a, b) => {
    const roleDelta = ROLE_ORDER[a.role] - ROLE_ORDER[b.role];
    return roleDelta !== 0 ? roleDelta : a.joinedAt - b.joinedAt;
  });
}

export async function buildRoomState(
  room: RoomRecord,
  self: ParticipantRecord,
): Promise<ServerPayloads["room_state"]> {
  const base: ServerPayloads["room_state"] = {
    room: toRoomSnapshot(room),
    self: toWireParticipant(self),
    participants: [],
    files: [],
    chat: [],
    waiting: [],
    serverTime: Date.now(),
  };

  if (self.state !== "ADMITTED") return base;

  const [participants, files, chat] = await Promise.all([
    listParticipants(room.id),
    listFiles(room.id),
    listChat(room.id),
  ]);

  const waiting = hasCapability(self, "admit")
    ? await listWaiting(room.id)
    : [];

  return {
    ...base,
    participants: sortParticipants(
      participants.filter(
        // Only live sockets belong in the roster. A dropped participant keeps
        // their record briefly so a reconnect restores the same identity, but
        // showing that record produced duplicate (often HOST) entries.
        (participant) =>
          participant.socketId !== null || participant.id === self.id,
      ),
    ),
    files,
    chat,
    waiting: waiting.map(toWireParticipant),
  };
}

/** Pushes the waiting queue to every participant allowed to admit people. */
export async function notifyWaiting(roomId: string): Promise<void> {
  const [participants, waiting] = await Promise.all([
    listParticipants(roomId),
    listWaiting(roomId),
  ]);
  const payload = { waiting: waiting.map(toWireParticipant) };
  for (const participant of participants) {
    if (participant.state !== "ADMITTED") continue;
    if (!hasCapability(participant, "admit")) continue;
    sendToParticipant(roomId, participant.id, "waiting_room", payload);
  }
}

export function canSeeWaiting(participant: ParticipantRecord): boolean {
  return hasCapability(participant, "admit");
}
