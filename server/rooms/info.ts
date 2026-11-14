import type { RoomInfoResponse } from '@/lib/api-types';
import {
  getEndedMarker,
  getRoomByKey,
  isParticipantPresent,
  listParticipants,
  listWaiting,
} from './repository';

/** Public, guest-safe room summary used by the lobby and key validation. */
export async function roomInfoByKey(
  sessionKey: string,
): Promise<RoomInfoResponse | 'ended' | null> {
  const room = await getRoomByKey(sessionKey);
  if (!room) {
    return (await getEndedMarker(sessionKey)) ? 'ended' : null;
  }
  const [participants, waiting] = await Promise.all([
    listParticipants(room.id),
    listWaiting(room.id),
  ]);
  const host = participants.find((entry) => entry.id === room.hostParticipantId);
  const admitted = participants.filter((entry) => isParticipantPresent(entry));

  return {
    key: room.key,
    title: room.title,
    status: room.status,
    admitMode: room.admitMode,
    workspaceMode: room.workspaceMode,
    rootName: room.rootName,
    hostName: host?.name ?? 'Host',
    participantCount: admitted.length,
    waitingCount: waiting.length,
    maxParticipants: room.maxParticipants,
    createdAt: room.createdAt,
  };
}
