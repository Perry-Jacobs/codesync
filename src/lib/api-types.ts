import { z } from 'zod';
import type { RoomStatus, WorkspaceMode } from './ws-protocol';

/**
 * HTTP contract between the browser and the Next route handlers. Shared types
 * only — the zod schemas stay server-side but live here so both sides agree.
 */

export const createRoomSchema = z.object({
  hostName: z.string().trim().min(1).max(48),
  title: z.string().trim().max(80).optional(),
  admitMode: z.enum(['auto', 'manual']).optional(),
});

export type CreateRoomRequest = z.infer<typeof createRoomSchema>;

export interface CreateRoomResponse {
  roomKey: string;
  roomId: string;
  hostToken: string;
  hostName: string;
  title: string;
  joinUrl: string;
}

export interface RoomInfoResponse {
  key: string;
  title: string;
  status: RoomStatus;
  admitMode: 'auto' | 'manual';
  workspaceMode: WorkspaceMode;
  rootName: string | null;
  hostName: string;
  participantCount: number;
  waitingCount: number;
  maxParticipants: number;
  createdAt: number;
}

export interface ApiError {
  error: string;
  code:
    | 'BAD_REQUEST'
    | 'NOT_FOUND'
    | 'GONE'
    | 'RATE_LIMITED'
    | 'INTERNAL'
    | 'UNAVAILABLE';
}

export interface RtcConfigResponse {
  iceServers: RTCIceServer[];
  maxBitrateKbps: number;
}
