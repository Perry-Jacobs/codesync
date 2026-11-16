import type { ServerMessage } from "@/lib/ws-protocol";
import type { SocketContext } from "./connection";
import { clearParticipant, recordPresence } from "./presence-store";

/** Applies shared bus events to this gateway's replay cache and socket ACLs. */
export interface RemoteRoomMessageResult {
  participantIdToClear: string | null;
  clearFileSubscriptions: boolean;
}

const NO_CLEANUP: RemoteRoomMessageResult = {
  participantIdToClear: null,
  clearFileSubscriptions: false,
};

export function applyRemoteRoomMessage(
  roomId: string,
  message: ServerMessage,
  sockets: Iterable<SocketContext>,
): RemoteRoomMessageResult {
  switch (message.type) {
    case "cursor": {
      const data = message.data;
      recordPresence(roomId, data.participantId, data.fileId, {
        kind: "cursor",
        line: data.line,
        column: data.column,
        topLine: data.topLine,
      });
      return NO_CLEANUP;
    }
    case "selection": {
      const data = message.data;
      recordPresence(roomId, data.participantId, data.fileId, {
        kind: "selection",
        ranges: data.ranges,
      });
      return NO_CLEANUP;
    }
    case "viewport": {
      const data = message.data;
      recordPresence(roomId, data.participantId, data.fileId, {
        kind: "viewport",
        topLine: data.topLine,
      });
      return NO_CLEANUP;
    }
    case "participant_left":
      clearParticipant(roomId, message.data.participantId);
      return {
        participantIdToClear: message.data.participantId,
        clearFileSubscriptions: true,
      };
    case "permission_changed": {
      for (const socket of sockets) {
        if (socket.participant?.id !== message.data.participantId) continue;
        socket.participant = {
          ...socket.participant,
          role: message.data.role,
          canEdit: message.data.canEdit,
          canSpeak: message.data.canSpeak,
        };
      }
      // CO_HOST edit access is still controlled by the per-participant grant;
      // only HOST has edit capability independent of canEdit in the ACL matrix.
      const canEdit = message.data.role === "HOST" || message.data.canEdit;
      if (!canEdit) {
        clearParticipant(roomId, message.data.participantId);
        return {
          participantIdToClear: message.data.participantId,
          // Keep subscriptions for read-only collaborators; local-folder
          // updates are gated by the refreshed socket ACL.
          clearFileSubscriptions: false,
        };
      }
      return NO_CLEANUP;
    }
  }
  return NO_CLEANUP;
}
