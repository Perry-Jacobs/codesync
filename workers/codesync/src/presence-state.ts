import type { CodeRange } from "./protocol";

export interface FilePresenceSnapshot {
  cursor?: { line: number; column: number; topLine?: number };
  selection?: CodeRange[];
  viewport?: number;
  updatedAt: number;
}

export type FilePresenceState = Record<
  string,
  Record<string, FilePresenceSnapshot>
>;

export type PresenceUpdate =
  | { kind: "cursor"; line: number; column: number; topLine?: number }
  | { kind: "selection"; ranges: CodeRange[] }
  | { kind: "viewport"; topLine: number };

export const PRESENCE_TTL_MS = 30_000;
const MAX_PARTICIPANTS_PER_FILE = 500;
const MAX_FILES_PER_SOCKET = 32;

export function updatePresenceSnapshot(
  state: FilePresenceState,
  participantId: string,
  fileId: string,
  update: PresenceUpdate,
  now = Date.now(),
): void {
  prunePresenceSnapshots(state, now);

  if (!state[fileId] && Object.keys(state).length >= MAX_FILES_PER_SOCKET) {
    const oldestFile = Object.entries(state).reduce((oldest, entry) => {
      const entryTime = Math.max(
        ...Object.values(entry[1]).map((snapshot) => snapshot.updatedAt),
      );
      const oldestTime = Math.max(
        ...Object.values(oldest[1]).map((snapshot) => snapshot.updatedAt),
      );
      return entryTime < oldestTime ? entry : oldest;
    });
    delete state[oldestFile[0]];
  }

  const snapshots = (state[fileId] ??= {});
  if (
    !snapshots[participantId] &&
    Object.keys(snapshots).length >= MAX_PARTICIPANTS_PER_FILE
  ) {
    const oldest = Object.entries(snapshots).reduce((current, entry) =>
      entry[1].updatedAt < current[1].updatedAt ? entry : current,
    );
    delete snapshots[oldest[0]];
  }

  const snapshot = (snapshots[participantId] ??= { updatedAt: now });
  if (update.kind === "cursor") {
    snapshot.cursor = {
      line: update.line,
      column: update.column,
      topLine: update.topLine,
    };
  } else if (update.kind === "selection") {
    snapshot.selection = update.ranges.map((range) => ({ ...range }));
  } else {
    snapshot.viewport = update.topLine;
  }
  snapshot.updatedAt = now;
}

export function prunePresenceSnapshots(
  state: FilePresenceState,
  now = Date.now(),
): void {
  for (const [fileId, participants] of Object.entries(state)) {
    for (const [participantId, snapshot] of Object.entries(participants)) {
      if (now - snapshot.updatedAt >= PRESENCE_TTL_MS) {
        delete participants[participantId];
      }
    }
    if (Object.keys(participants).length === 0) delete state[fileId];
  }
}

export function clearParticipantPresence(
  state: FilePresenceState,
  participantId: string,
): void {
  for (const [fileId, participants] of Object.entries(state)) {
    delete participants[participantId];
    if (Object.keys(participants).length === 0) delete state[fileId];
  }
}

export function clearFilePresence(
  state: FilePresenceState,
  fileId: string,
): void {
  delete state[fileId];
}

export function clearAllPresence(state: FilePresenceState): void {
  for (const fileId of Object.keys(state)) delete state[fileId];
}
