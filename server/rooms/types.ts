import type {
  AdmitMode,
  FileMeta,
  Participant,
  RoomStatus,
  WorkspaceMode,
} from '@/lib/ws-protocol';

export interface RoomRecord {
  id: string;
  key: string;
  title: string;
  status: RoomStatus;
  admitMode: AdmitMode;
  hostParticipantId: string;
  allowGuestScreenShare: boolean;
  maxParticipants: number;
  workspaceMode: WorkspaceMode;
  rootName: string | null;
  createdAt: number;
  lastActivityAt: number;
}

export interface ParticipantRecord extends Participant {
  /** Socket currently bound to this participant, if any. */
  socketId: string | null;
  lastSeenAt: number;
}

/** Cursor/avatar palette — stable per participant for the life of the room. */
export const PARTICIPANT_COLORS = [
  '#4ea1ff',
  '#f2a33c',
  '#7ee787',
  '#ff7b9c',
  '#c792ea',
  '#5ad4c8',
  '#ffb86c',
  '#a3b8ff',
  '#f78c6c',
  '#8bd5ff',
] as const;

export function pickColor(seed: number): string {
  return PARTICIPANT_COLORS[seed % PARTICIPANT_COLORS.length] ?? PARTICIPANT_COLORS[0];
}

export interface WorkspaceFile extends FileMeta {
  /** Mirrors the on-disk path on the host machine. Never sent to guests. */
  diskPath?: string;
}

export function toWireParticipant(record: ParticipantRecord): Participant {
  const { socketId: _socketId, lastSeenAt: _lastSeenAt, ...wire } = record;
  void _socketId;
  void _lastSeenAt;
  return wire;
}

export function isParticipantRecord(value: unknown): value is ParticipantRecord {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.name === 'string' &&
    typeof candidate.role === 'string' &&
    typeof candidate.state === 'string'
  );
}
