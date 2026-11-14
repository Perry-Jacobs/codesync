import type { ClientPayloads } from '@/lib/ws-protocol';
import type { SocketContext } from '../connection';

export async function handlePing(
  ctx: SocketContext,
  data: ClientPayloads['ping'],
): Promise<void> {
  ctx.send('pong', { t: data.t, serverTime: Date.now() });
}
