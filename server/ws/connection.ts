import { nanoid } from 'nanoid';
import type { WebSocket } from 'ws';
import {
  PROTOCOL_VERSION,
  type ServerMessage,
  type ServerPayloads,
  type ServerType,
} from '@/lib/ws-protocol';
import type { ParticipantRecord } from '../rooms/types';
import { QuotaLimiter, TokenBucket } from '../rate-limit';
import { getEnv } from '@/lib/env';

export interface SocketContext {
  readonly id: string;
  readonly ws: WebSocket;
  readonly ip: string;
  readonly origin: string | null;
  readonly bucket: TokenBucket;
  readonly quotas: QuotaLimiter;
  roomId: string | null;
  participant: ParticipantRecord | null;
  joined: boolean;
  alive: boolean;
  violations: number;
  authTimer: ReturnType<typeof setTimeout> | null;
  send<K extends ServerType>(type: K, data: ServerPayloads[K]): void;
  sendMessage(message: ServerMessage): void;
  close(code: number, reason: string): void;
  bind(roomId: string, participant: ParticipantRecord): void;
  unbind(): void;
}

const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

export function createSocketContext(
  ws: WebSocket,
  ip: string,
  origin: string | null,
): SocketContext {
  const ctx: SocketContext = {
    id: `s_${nanoid(12)}`,
    ws,
    ip,
    origin,
    bucket: new TokenBucket(getEnv().RATE_LIMIT_MSGS_PER_SEC),
    quotas: new QuotaLimiter(),
    roomId: null,
    participant: null,
    joined: false,
    alive: true,
    violations: 0,
    authTimer: null,
    send(type, data) {
      const message = {
        v: PROTOCOL_VERSION,
        id: `m_${nanoid(12)}`,
        type,
        ts: Date.now(),
        data,
      } as ServerMessage;
      ctx.sendMessage(message);
    },
    sendMessage(message) {
      if (ws.readyState !== ws.OPEN) return;
      if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
        ws.terminate();
        return;
      }
      ws.send(JSON.stringify(message));
    },
    close(code, reason) {
      if (ctx.authTimer) {
        clearTimeout(ctx.authTimer);
        ctx.authTimer = null;
      }
      try {
        ws.close(code, reason.slice(0, 120));
      } catch {
        ws.terminate();
      }
    },
    bind(roomId, participant) {
      ctx.roomId = roomId;
      ctx.participant = participant;
      ctx.joined = true;
      if (ctx.authTimer) {
        clearTimeout(ctx.authTimer);
        ctx.authTimer = null;
      }
    },
    unbind() {
      ctx.roomId = null;
      ctx.participant = null;
      ctx.joined = false;
    },
  };
  return ctx;
}
