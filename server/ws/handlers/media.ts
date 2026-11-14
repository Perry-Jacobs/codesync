import type { ClientPayloads } from '@/lib/ws-protocol';
import { getParticipant } from '../../rooms/repository';
import { sendToParticipant } from '../broadcast';
import type { SocketContext } from '../connection';
import { requireRoom } from './code';
import { WsError } from '../../errors';

export async function handleWebrtcSignal(
  ctx: SocketContext,
  data: ClientPayloads['webrtc_signal'],
): Promise<void> {
  const { room, participant } = await requireRoom(ctx);
  if (data.targetId === participant.id) return;

  const target = await getParticipant(room.id, data.targetId);
  if (!target || target.state !== 'ADMITTED') {
    throw new WsError('CONFLICT', 'Peer is no longer in this room');
  }

  sendToParticipant(room.id, target.id, 'webrtc_signal', {
    fromId: participant.id,
    signal: data.signal,
  });
}
