import type { WsErrorCode } from '@/lib/ws-protocol';

/** Expected, client-safe failures thrown inside message handlers. */
export class WsError extends Error {
  readonly code: WsErrorCode;
  readonly requestId?: string;

  constructor(code: WsErrorCode, message: string, requestId?: string) {
    super(message);
    this.name = 'WsError';
    this.code = code;
    this.requestId = requestId;
  }
}

export function wsError(code: WsErrorCode, message: string): never {
  throw new WsError(code, message);
}

export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}
