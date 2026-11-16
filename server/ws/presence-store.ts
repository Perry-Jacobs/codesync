import type { CodeRange } from "@/lib/ws-protocol";
import {
  clearFilePresence,
  clearParticipantPresence,
  prunePresenceSnapshots,
  updatePresenceSnapshot,
  type FilePresenceState,
} from "@/lib/presence-state";

/**
 * Per-room presence snapshots for the Node gateway. The Worker keeps the same
 * structure on each socket attachment; the Node gateway keeps one store per
 * live participant so a late joiner can be replayed the cursors that were last
 * reported for the file it opens.
 */
const roomPresence = new Map<string, Map<string, FilePresenceState>>();

export interface PresenceReplayMessage {
  participantId: string;
  fileId: string;
  cursor?: { line: number; column: number; topLine?: number };
  selection?: CodeRange[];
  viewport?: number;
}

function roomState(roomId: string): Map<string, FilePresenceState> {
  let state = roomPresence.get(roomId);
  if (!state) {
    state = new Map();
    roomPresence.set(roomId, state);
  }
  return state;
}

export function recordPresence(
  roomId: string,
  participantId: string,
  fileId: string,
  update:
    | { kind: "cursor"; line: number; column: number; topLine?: number }
    | { kind: "selection"; ranges: CodeRange[] }
    | { kind: "viewport"; topLine: number },
): void {
  const participants = roomState(roomId);
  let presence = participants.get(participantId);
  if (!presence) {
    presence = {};
    participants.set(participantId, presence);
  }
  updatePresenceSnapshot(presence, participantId, fileId, update);
}

/** Snapshots for a file that are still within their TTL, excluding the viewer. */
export function presenceForFile(
  roomId: string,
  fileId: string,
  excludeParticipantId: string,
): PresenceReplayMessage[] {
  const participants = roomPresence.get(roomId);
  if (!participants) return [];
  const now = Date.now();
  const result: PresenceReplayMessage[] = [];
  for (const [participantId, presence] of participants) {
    if (participantId === excludeParticipantId) continue;
    prunePresenceSnapshots(presence, now);
    const snapshot = presence[fileId]?.[participantId];
    if (!snapshot) continue;
    result.push({
      participantId,
      fileId,
      cursor: snapshot.cursor,
      selection: snapshot.selection,
      viewport: snapshot.viewport,
    });
  }
  return result;
}

export function clearParticipant(roomId: string, participantId: string): void {
  const participants = roomPresence.get(roomId);
  if (!participants) return;
  participants.delete(participantId);
  if (participants.size === 0) roomPresence.delete(roomId);
}

export function clearRoomPresence(roomId: string): void {
  roomPresence.delete(roomId);
}

export function forgetFile(roomId: string, fileId: string): void {
  const participants = roomPresence.get(roomId);
  if (!participants) return;
  for (const presence of participants.values())
    clearFilePresence(presence, fileId);
}

/** Removing edit access must also erase the presence it produced. */
export function clearParticipantFilePresence(
  roomId: string,
  participantId: string,
): void {
  const participants = roomPresence.get(roomId);
  if (!participants) return;
  const presence = participants.get(participantId);
  if (!presence) return;
  clearParticipantPresence(presence, participantId);
  if (Object.keys(presence).length === 0) participants.delete(participantId);
}
