import type { ClientPayloads, Role } from "@/lib/ws-protocol";
import {
  canAssignRole,
  canEndSession,
  canKick,
  canManageParticipant,
  canTransferHost,
  defaultsForRole,
  hasCapability,
} from "@/lib/acl";
import {
  dequeueWaiting,
  admitParticipantSlot,
  getParticipant,
  getRoom,
  listParticipants,
  listWaiting,
  removeParticipant,
  transferHost,
  updateParticipant,
  updateRoom,
} from "../../rooms/repository";
import { issueReconnectToken } from "../../rooms/tokens";
import {
  toWireParticipant,
  type ParticipantRecord,
  type RoomRecord,
} from "../../rooms/types";
import { WsError } from "../../errors";
import { createLogger } from "../../logger";
import {
  closeRoomSockets,
  emit,
  findSocket,
  refreshSocketParticipant,
  sendToParticipant,
} from "../broadcast";
import { clearParticipant } from "../presence-store";
import { buildRoomState, notifyWaiting } from "../state";
import type { SocketContext } from "../connection";
import { flushAll, clearRoomDocs } from "../../yjs/store";
import { flushWorkspaceToDisk } from "../../fs/writeback";
import { publishFsCancellation } from "../../fs/pending";
import { endRoom, purgeRoom } from "../../rooms/repository";
import { WS_CLOSE } from "@/lib/ws-protocol";

const log = createLogger({ scope: "host" });

interface RoomContext {
  room: RoomRecord;
  actor: ParticipantRecord;
}

async function requireContext(ctx: SocketContext): Promise<RoomContext> {
  if (!ctx.roomId || !ctx.participant)
    throw new WsError("UNAUTHENTICATED", "Join a room first");
  const room = await getRoom(ctx.roomId);
  if (!room) throw new WsError("ROOM_NOT_FOUND", "Room no longer exists");
  if (room.status === "ended") {
    throw new WsError("ROOM_ENDED", "The session has ended");
  }
  const fresh = await getParticipant(room.id, ctx.participant.id);
  if (!fresh || fresh.state !== "ADMITTED") {
    throw new WsError("NOT_ADMITTED", "You are not admitted to this room");
  }
  if (fresh.socketId !== ctx.id) {
    throw new WsError(
      "FORBIDDEN",
      "This connection was resumed or replaced in another session",
    );
  }
  ctx.participant = fresh;
  return { room, actor: fresh };
}

function assignedRole(payload: Record<string, unknown> | undefined): Role {
  const value = payload?.role;
  return value === "CO_HOST" || value === "EDITOR" || value === "VIEWER"
    ? value
    : "VIEWER";
}

async function persistGrant(
  roomId: string,
  target: ParticipantRecord,
  patch: Partial<ParticipantRecord>,
  reason: string,
): Promise<ParticipantRecord> {
  const next = await updateParticipant(roomId, target.id, patch);
  if (!next) throw new WsError("CONFLICT", "Participant no longer exists");
  refreshSocketParticipant(roomId, next);
  if (!hasCapability(next, "edit_code")) clearParticipant(roomId, next.id);
  emit(roomId, "permission_changed", {
    participantId: next.id,
    role: next.role,
    canEdit: next.canEdit,
    canSpeak: next.canSpeak,
    reason,
  });
  return next;
}

async function admitParticipant(
  room: RoomRecord,
  target: ParticipantRecord,
  role: Role,
): Promise<boolean> {
  const grants = defaultsForRole(role);
  const next: ParticipantRecord = {
    ...target,
    role,
    state: "ADMITTED",
    canEdit: grants.canEdit,
    canSpeak: grants.canSpeak,
    mic: false,
    cam: false,
    screen: false,
    typing: false,
  };
  const admitted = await admitParticipantSlot(
    room.id,
    next,
    room.maxParticipants,
  );
  if (!admitted) return false;
  await dequeueWaiting(room.id, next.id);
  refreshSocketParticipant(room.id, next);

  const token = await issueReconnectToken(next.id, room.id, next.role);
  sendToParticipant(
    room.id,
    next.id,
    "room_state",
    await buildRoomState(room, next),
  );
  sendToParticipant(room.id, next.id, "admitted", {
    reconnectToken: token,
    self: toWireParticipant(next),
  });
  emit(
    room.id,
    "participant_joined",
    { participant: toWireParticipant(next) },
    {},
  );
  await notifyWaiting(room.id);
  log.info("participant admitted", {
    roomId: room.id,
    participantId: next.id,
    role,
  });
  return true;
}

async function denyParticipant(
  room: RoomRecord,
  target: ParticipantRecord,
): Promise<void> {
  // Terminal records are immutable in Redis; a repeated deny is a no-op, not
  // a conflict, so the host UI never shows a misleading failure.
  if (target.state === "DENIED" || target.state === "REMOVED") return;
  const next = await updateParticipant(room.id, target.id, {
    state: "DENIED",
    socketId: null,
  });
  if (!next) throw new WsError("CONFLICT", "Participant no longer exists");
  await dequeueWaiting(room.id, next.id);
  if (target.socketId) {
    const socket = findSocket(room.id, target.socketId);
    if (socket) {
      socket.send("denied", { reason: "The host denied your request to join" });
      socket.unbind();
      setTimeout(() => socket.close(4003, "Denied by host"), 120);
    }
  }
  await notifyWaiting(room.id);
}

async function kickParticipant(
  room: RoomRecord,
  target: ParticipantRecord,
  reason: string,
): Promise<void> {
  // Already removed (or denied): the participant_left event already went out;
  // a repeat click must not surface a conflict for an immutable record.
  if (target.state === "REMOVED" || target.state === "DENIED") return;
  const next = await updateParticipant(room.id, target.id, {
    state: "REMOVED",
    socketId: null,
    typing: false,
  });
  if (!next) throw new WsError("CONFLICT", "Participant no longer exists");
  // A removed participant keeps no cursor behind for the people still editing.
  clearParticipant(room.id, target.id);
  if (target.socketId) {
    const socket = findSocket(room.id, target.socketId);
    if (socket) {
      socket.send("kicked", { reason });
      socket.unbind();
      setTimeout(
        () => socket.close(WS_CLOSE.FORBIDDEN, "Removed by host"),
        120,
      );
    }
  }
  emit(
    room.id,
    "participant_left",
    { participantId: target.id, reason: "kicked" },
    {},
  );
  log.info("participant removed", {
    roomId: room.id,
    participantId: target.id,
  });
}

export async function handleHostAction(
  ctx: SocketContext,
  data: ClientPayloads["host_action"],
): Promise<void> {
  const { room, actor } = await requireContext(ctx);
  const target = data.targetId
    ? await getParticipant(room.id, data.targetId)
    : null;

  const requireTarget = (): ParticipantRecord => {
    if (!target)
      throw new WsError("INVALID_MESSAGE", "Target participant not found");
    return target;
  };
  const requireCapability = (
    capability: Parameters<typeof hasCapability>[1],
  ): void => {
    if (!hasCapability(actor, capability)) {
      throw new WsError(
        "FORBIDDEN",
        `You are not allowed to ${data.action.replaceAll("_", " ")}`,
      );
    }
  };

  switch (data.action) {
    case "admit": {
      requireCapability("admit");
      const waiting = requireTarget();
      if (waiting.state !== "WAITING")
        throw new WsError("CONFLICT", "Participant is not waiting");
      const role =
        actor.role === "HOST" || hasCapability(actor, "manage_roles")
          ? assignedRole(data.payload)
          : "VIEWER";
      if (role !== "VIEWER" && !canAssignRole(actor, role)) {
        throw new WsError("FORBIDDEN", "You cannot assign that role");
      }
      const admitted = await admitParticipant(room, waiting, role);
      if (!admitted)
        throw new WsError("PARTICIPANT_LIMIT", "This session is full");
      break;
    }
    case "admit_all": {
      requireCapability("admit");
      const waiting = await listWaiting(room.id);
      for (const candidate of waiting) {
        const admitted = await admitParticipant(room, candidate, "VIEWER");
        if (!admitted) break;
      }
      break;
    }
    case "deny": {
      requireCapability("admit");
      const waiting = requireTarget();
      if (waiting.state !== "WAITING")
        throw new WsError("CONFLICT", "Participant is not waiting");
      await denyParticipant(room, waiting);
      break;
    }
    case "kick": {
      const victim = requireTarget();
      if (!canKick(actor, victim))
        throw new WsError("FORBIDDEN", "You cannot remove this participant");
      await kickParticipant(room, victim, "Removed by host");
      break;
    }
    case "lock_room":
    case "unlock_room": {
      requireCapability("lock_room");
      const locked = data.action === "lock_room";
      await updateRoom(room.id, { status: locked ? "locked" : "open" });
      emit(room.id, "host_action", {
        action: data.action,
        actorId: actor.id,
        payload: { locked },
      });
      break;
    }
    case "set_role": {
      const victim = requireTarget();
      const role = assignedRole(data.payload);
      if (!canManageParticipant(actor, victim)) {
        throw new WsError("FORBIDDEN", "You cannot change this participant");
      }
      if (!canAssignRole(actor, role))
        throw new WsError("FORBIDDEN", "Role change not permitted");
      await persistGrant(
        room.id,
        victim,
        { role, ...defaultsForRole(role) },
        `role:${role}`,
      );
      // Read-only participants keep an already-open file. Losing edit access
      // clears their cursor, not the content they are following.
      break;
    }
    case "grant_edit":
    case "revoke_edit": {
      const victim = requireTarget();
      if (!canManageParticipant(actor, victim))
        throw new WsError("FORBIDDEN", "Not allowed");
      const canEdit = data.action === "grant_edit";
      await persistGrant(
        room.id,
        victim,
        { canEdit },
        canEdit ? "granted_edit" : "revoked_edit",
      );
      break;
    }
    case "grant_speak":
    case "revoke_speak": {
      const victim = requireTarget();
      if (!canManageParticipant(actor, victim))
        throw new WsError("FORBIDDEN", "Not allowed");
      const canSpeak = data.action === "grant_speak";
      const next = await persistGrant(
        room.id,
        victim,
        canSpeak ? { canSpeak, handRaised: false } : { canSpeak, mic: false },
        canSpeak ? "granted_speak" : "revoked_speak",
      );
      if (!canSpeak) {
        emit(
          room.id,
          "participant_updated",
          { participant: toWireParticipant(next) },
          {},
        );
        sendToParticipant(room.id, victim.id, "host_action", {
          action: "mute",
          actorId: actor.id,
          targetId: victim.id,
          payload: { reason: "speak_revoked" },
        });
      } else if (victim.handRaised) {
        // Granting the floor answers the raised hand; sync the cleared flag.
        emit(
          room.id,
          "participant_updated",
          { participant: toWireParticipant(next) },
          {},
        );
      }
      break;
    }
    case "mute": {
      requireCapability("manage_media");
      const victim = requireTarget();
      if (!canManageParticipant(actor, victim))
        throw new WsError("FORBIDDEN", "Not allowed");
      const next = await updateParticipant(room.id, victim.id, { mic: false });
      if (!next) throw new WsError("CONFLICT", "Participant no longer exists");
      refreshSocketParticipant(room.id, next);
      emit(
        room.id,
        "participant_updated",
        { participant: toWireParticipant(next) },
        {},
      );
      sendToParticipant(room.id, victim.id, "host_action", {
        action: "mute",
        actorId: actor.id,
        targetId: victim.id,
      });
      break;
    }
    case "ask_unmute": {
      requireCapability("manage_media");
      const victim = requireTarget();
      if (!victim.canSpeak)
        throw new WsError("CONFLICT", "Participant has no speak permission");
      sendToParticipant(room.id, victim.id, "host_action", {
        action: "ask_unmute",
        actorId: actor.id,
        targetId: victim.id,
      });
      break;
    }
    case "transfer_host": {
      if (!canTransferHost(actor))
        throw new WsError("FORBIDDEN", "Only the host can transfer host");
      const victim = requireTarget();
      if (victim.id === actor.id || victim.state !== "ADMITTED") {
        throw new WsError("CONFLICT", "Pick an admitted participant");
      }
      const oldHost: ParticipantRecord = {
        ...actor,
        role: "CO_HOST",
        canEdit: true,
        canSpeak: true,
      };
      const newHost: ParticipantRecord = {
        ...victim,
        role: "HOST",
        canEdit: true,
        canSpeak: true,
      };
      const transferred = await transferHost(room.id, actor, victim);
      if (!transferred) {
        throw new WsError("CONFLICT", "Host ownership changed; try again");
      }
      refreshSocketParticipant(room.id, oldHost);
      refreshSocketParticipant(room.id, newHost);
      ctx.participant = oldHost;
      for (const changed of [oldHost, newHost]) {
        emit(room.id, "permission_changed", {
          participantId: changed.id,
          role: changed.role,
          canEdit: changed.canEdit,
          canSpeak: changed.canSpeak,
          reason: "host_transfer",
        });
      }
      emit(room.id, "host_action", {
        action: "transfer_host",
        actorId: actor.id,
        targetId: newHost.id,
        payload: { hostParticipantId: newHost.id },
      });
      // The durable host credential is a bearer secret, so deliver it only to
      // the new host rather than broadcasting it with the room event.
      sendToParticipant(room.id, newHost.id, "host_action", {
        action: "transfer_host",
        actorId: actor.id,
        targetId: newHost.id,
        payload: {
          hostParticipantId: newHost.id,
          hostToken: transferred.hostToken,
        },
      });
      break;
    }
    case "end_session": {
      if (!canEndSession(actor))
        throw new WsError("FORBIDDEN", "Only the host can end the session");
      const ended = await endRoom(room.id);
      if (!ended) throw new WsError("ROOM_NOT_FOUND", "Room no longer exists");
      publishFsCancellation(room.id, "Session ended");
      await flushAll();
      await clearRoomDocs(room.id);
      emit(room.id, "room_ended", { reason: "host_ended" }, {});
      setTimeout(
        () => closeRoomSockets(room.id, WS_CLOSE.ROOM_ENDED, "Session ended"),
        200,
      );
      setTimeout(() => void purgeRoom(room.id), 60_000);
      log.info("session ended", { roomId: room.id, by: actor.id });
      break;
    }
    case "toggle_admit_mode": {
      requireCapability("admit");
      const admitMode = room.admitMode === "auto" ? "manual" : "auto";
      await updateRoom(room.id, { admitMode });
      emit(room.id, "host_action", {
        action: "toggle_admit_mode",
        actorId: actor.id,
        payload: { admitMode },
      });
      break;
    }
    case "toggle_screen_share": {
      requireCapability("manage_media");
      const allowGuestScreenShare = !room.allowGuestScreenShare;
      await updateRoom(room.id, { allowGuestScreenShare });
      emit(room.id, "host_action", {
        action: "toggle_screen_share",
        actorId: actor.id,
        payload: { allowGuestScreenShare },
      });
      break;
    }
    case "save_workspace": {
      if (room.hostParticipantId !== actor.id) {
        throw new WsError("FORBIDDEN", "Only the host can save to disk");
      }
      const operationId =
        typeof data.payload?.operationId === "string"
          ? data.payload.operationId.slice(0, 64)
          : `save_${Date.now()}`;
      sendToParticipant(room.id, actor.id, "workspace_save", {
        operationId,
        phase: "saving",
        mode: room.workspaceMode,
        total: 0,
        saved: 0,
        failed: 0,
        failures: [],
      });

      if (room.workspaceMode === "local-fs") {
        const result = await flushWorkspaceToDisk(room.id);
        sendToParticipant(room.id, actor.id, "workspace_save", {
          operationId,
          phase: result.status,
          mode: room.workspaceMode,
          total: result.total,
          saved: result.saved,
          failed: result.failed,
          failures: result.failures,
        });
      } else {
        await flushAll();
        sendToParticipant(room.id, actor.id, "workspace_save", {
          operationId,
          phase: "success",
          mode: room.workspaceMode,
          total: 0,
          saved: 0,
          failed: 0,
          failures: [],
        });
      }
      break;
    }
    default: {
      throw new WsError("INVALID_MESSAGE", "Unknown host action");
    }
  }
}

export async function handlePermissionRequest(
  ctx: SocketContext,
  kind: "edit" | "speak",
  note?: string,
): Promise<void> {
  const { room, actor } = await requireContext(ctx);
  const participants = await listParticipants(room.id);
  for (const participant of participants) {
    if (participant.id === actor.id) continue;
    if (participant.state !== "ADMITTED") continue;
    if (!hasCapability(participant, "manage_roles")) continue;
    sendToParticipant(room.id, participant.id, "permission_request", {
      participantId: actor.id,
      name: actor.name,
      kind,
      note,
    });
  }
}

/** Called on disconnect to make sure a waiting participant is removed cleanly. */
export async function dropWaiting(
  roomId: string,
  participantId: string,
): Promise<void> {
  await removeParticipant(roomId, participantId);
  await notifyWaiting(roomId);
}
