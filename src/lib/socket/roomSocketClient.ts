"use client";

import { nanoid } from "nanoid";
import {
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  type ClientMessage,
  type ClientPayloads,
  type ClientType,
  type ServerMessage,
} from "@/lib/ws-protocol";
import { parseServerMessage } from "@/lib/ws-schemas";

export type ConnectionStatus =
  "idle" | "connecting" | "open" | "reconnecting" | "closed";

export interface JoinCredentials {
  roomKey: string;
  displayName: string;
  hostToken?: string;
  reconnectToken?: string;
  mic: boolean;
  cam: boolean;
}

export interface RoomSocketHandlers {
  onStatus(status: ConnectionStatus): void;
  onMessage(message: ServerMessage): void;
}

const HEARTBEAT_MS = 20_000;
const STALE_MS = 45_000;
const MAX_QUEUED = 20;

export function resolveWsUrl(): string {
  const configured = process.env.NEXT_PUBLIC_WS_URL;
  if (configured) return configured;
  if (typeof window === "undefined") return "ws://localhost:3000/ws";
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
}

export class RoomSocketClient {
  private socket: WebSocket | null = null;
  private credentials: JoinCredentials | null = null;
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastSeen = 0;
  private manualClose = false;
  private queued: ClientMessage[] = [];
  private admitted = false;
  private status: ConnectionStatus = "idle";

  constructor(
    private readonly url: string,
    private readonly handlers: RoomSocketHandlers,
  ) {}

  connect(credentials: JoinCredentials): void {
    this.credentials = { ...credentials };
    this.manualClose = false;
    this.attempts = 0;
    // A reconnect timer scheduled for a previous socket drop must die with
    // this explicit connect, otherwise it fires later and opens a second
    // socket while this one is live (duplicate joins, server-side evictions).
    this.clearTimers();
    this.closeSocket();
    this.setStatus("connecting");
    this.open();
  }

  updateCredentials(patch: Partial<JoinCredentials>): void {
    if (!this.credentials) return;
    this.credentials = { ...this.credentials, ...patch };
  }

  /**
   * Retries the join handshake with corrected credentials on the existing
   * socket. Used when a stale reconnect token is rejected but the tab still
   * holds a host credential that can reclaim the session.
   */
  retryJoin(patch: Partial<JoinCredentials>): boolean {
    if (!this.credentials) return false;
    this.credentials = { ...this.credentials, ...patch };
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.admitted = false;
      this.sendJoin();
      return true;
    }
    if (this.manualClose) return false;
    this.reconnectNow();
    return true;
  }

  disconnect(): void {
    this.manualClose = true;
    this.clearTimers();
    this.closeSocket();
    this.queued = [];
    this.setStatus("idle");
  }

  /**
   * End the socket without clearing the session. Used when the server says the
   * room is over so the UI can keep rendering its closed state instead of
   * reconnecting in a loop and replaying the same error toast.
   */
  stopReconnecting(): void {
    this.manualClose = true;
    this.clearTimers();
    this.closeSocket();
    this.queued = [];
    this.setStatus("idle");
  }

  reconnectNow(): void {
    if (!this.credentials || this.manualClose) return;
    if (
      this.socket?.readyState === WebSocket.OPEN ||
      this.socket?.readyState === WebSocket.CONNECTING
    )
      return;
    this.clearTimers();
    this.closeSocket();
    this.setStatus("reconnecting");
    this.open();
  }

  send<K extends ClientType>(type: K, data: ClientPayloads[K]): string {
    const message: ClientMessage = {
      v: PROTOCOL_VERSION,
      id: `c_${nanoid(10)}`,
      type,
      ts: Date.now(),
      data,
    } as ClientMessage;

    const frame = this.serializeFrame(message);
    if (
      this.socket?.readyState === WebSocket.OPEN &&
      this.admitted &&
      type !== "ping"
    ) {
      this.socket.send(frame);
    } else if (type === "chat_send" && this.queued.length < MAX_QUEUED) {
      // Chat is the only operation safe to replay after admission. Other
      // operations are rejected visibly instead of being silently discarded.
      this.queued.push(message);
    } else {
      throw new Error(
        type === "chat_send"
          ? "The chat queue is full; reconnect before sending more messages."
          : "The session is not connected. Your action was not sent.",
      );
    }
    return message.id;
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  /** The room this client is currently attached to, if any. */
  getRoomKey(): string | null {
    return this.credentials?.roomKey ?? null;
  }

  private open(): void {
    const wsUrl = new URL(this.url);
    if (this.credentials?.roomKey) {
      wsUrl.searchParams.set("room", this.credentials.roomKey);
    }
    const ws = new WebSocket(wsUrl);
    this.socket = ws;

    ws.onopen = () => {
      this.lastSeen = Date.now();
      this.attempts = 0;
      this.admitted = false;
      this.setStatus("open");
      this.sendJoin();
      this.startHeartbeat();
    };

    ws.onmessage = (event: MessageEvent<string>) => {
      this.lastSeen = Date.now();
      const parsed = parseServerMessage(event.data);
      if (!parsed.ok) {
        console.warn(
          "[codesync] rejected invalid server message",
          parsed.detail,
        );
        return;
      }
      const message = parsed.message;
      if (message.type === "admitted") {
        this.admitted = true;
        if (message.data.reconnectToken) {
          this.updateCredentials({
            reconnectToken: message.data.reconnectToken,
          });
        }
      }
      this.handlers.onMessage(message);
      if (message.type === "admitted") this.flushQueue();
    };

    ws.onerror = () => {
      // The close handler drives reconnection.
    };

    ws.onclose = () => {
      if (this.socket !== ws) return;
      this.socket = null;
      this.admitted = false;
      this.stopHeartbeat();
      this.setStatus("closed");
      if (!this.manualClose) this.scheduleReconnect();
    };
  }

  private sendJoin(): void {
    if (!this.credentials || this.socket?.readyState !== WebSocket.OPEN) return;
    const payload: ClientPayloads["join_room"] = {
      roomKey: this.credentials.roomKey,
      displayName: this.credentials.displayName,
      hostToken: this.credentials.hostToken,
      reconnectToken: this.credentials.reconnectToken,
      media: { mic: this.credentials.mic, cam: this.credentials.cam },
      client: {
        supportsFs:
          typeof window !== "undefined" && "showDirectoryPicker" in window,
        appVersion: "1.0.0",
      },
    };
    const message: ClientMessage = {
      v: PROTOCOL_VERSION,
      id: `c_${nanoid(10)}`,
      type: "join_room",
      ts: Date.now(),
      data: payload,
    } as ClientMessage;
    this.sendFrame(message);
  }

  private flushQueue(): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    for (const message of this.queued) this.sendFrame(message);
    this.queued = [];
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay =
      Math.min(8000, 500 * 2 ** this.attempts) + Math.random() * 400;
    this.attempts += 1;
    this.setStatus("reconnecting");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.manualClose || !this.credentials) return;
      this.open();
    }, delay);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastSeen > STALE_MS) {
        this.socket.close(4000, "Heartbeat timeout");
        return;
      }
      const message: ClientMessage = {
        v: PROTOCOL_VERSION,
        id: `c_${nanoid(10)}`,
        type: "ping",
        ts: Date.now(),
        data: { t: Date.now() },
      } as ClientMessage;
      this.sendFrame(message);
    }, HEARTBEAT_MS);
  }

  private serializeFrame(message: ClientMessage): string {
    const frame = JSON.stringify(message);
    const bytes = new TextEncoder().encode(frame).byteLength;
    if (bytes > MAX_MESSAGE_BYTES) {
      throw new Error(
        `Outbound WebSocket frame is too large (${bytes} bytes; limit ${MAX_MESSAGE_BYTES}).`,
      );
    }
    return frame;
  }

  private sendFrame(message: ClientMessage): void {
    const frame = this.serializeFrame(message);
    if (this.socket?.readyState !== WebSocket.OPEN) {
      throw new Error(
        "Cannot send a WebSocket frame while the connection is not open.",
      );
    }
    this.socket.send(frame);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private closeSocket(): void {
    const ws = this.socket;
    this.socket = null;
    if (!ws) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    try {
      ws.close(1000, "Client closing");
    } catch {
      // Already closed.
    }
  }

  private clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.handlers.onStatus(status);
  }
}
