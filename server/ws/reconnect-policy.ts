import type {
  ParticipantState,
  RoomStatus,
  WsErrorCode,
} from "@/lib/ws-protocol";

export interface ReconnectRejection {
  code: WsErrorCode;
  message: string;
}

/**
 * A reconnect credential restores an existing admitted identity only. It does
 * not create an admission path for a waiting participant, resurrect a departed
 * participant, or enter a locked room.
 */
export function reconnectRejection(
  roomStatus: RoomStatus,
  participantState: ParticipantState | null,
): ReconnectRejection | null {
  if (roomStatus === "ended") {
    return { code: "ROOM_ENDED", message: "The host ended this session" };
  }
  if (roomStatus === "locked") {
    return { code: "ROOM_LOCKED", message: "The host locked this session" };
  }
  if (participantState === null) {
    return {
      code: "FORBIDDEN",
      message: "This participant can no longer rejoin the session",
    };
  }
  if (participantState === "WAITING") {
    return {
      code: "NOT_ADMITTED",
      message: "This participant is waiting for host approval",
    };
  }
  if (participantState !== "ADMITTED") {
    return {
      code: "FORBIDDEN",
      message: "This participant can no longer rejoin the session",
    };
  }
  return null;
}
