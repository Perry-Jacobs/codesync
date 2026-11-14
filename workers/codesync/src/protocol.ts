/**
 * Wire contract shared by the browser client and the WebSocket gateway.
 * This module must stay dependency-free so both bundles can import it.
 */

export const PROTOCOL_VERSION = 1 as const;

export interface RTCIceCandidateInit {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

export interface RTCIceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}
export const MAX_MESSAGE_BYTES = 480_000;
/** Maximum workspace text payload carried by the filesystem protocol. */
export const MAX_CONTENT_CHARS = 400_000;

export type Role = "HOST" | "CO_HOST" | "EDITOR" | "VIEWER" | "GUEST";
export type ParticipantState =
  "WAITING" | "ADMITTED" | "LEFT" | "REMOVED" | "DENIED";
export type RoomStatus = "open" | "locked" | "ended";
export type AdmitMode = "auto" | "manual";
export type WorkspaceMode = "virtual" | "local-fs";

export interface Envelope<T extends string, D> {
  v: typeof PROTOCOL_VERSION;
  /** Client-generated correlation id, echoed back in error.requestId when relevant. */
  id: string;
  type: T;
  ts: number;
  data: D;
}

export interface Participant {
  id: string;
  name: string;
  role: Role;
  color: string;
  state: ParticipantState;
  canEdit: boolean;
  canSpeak: boolean;
  mic: boolean;
  cam: boolean;
  screen: boolean;
  handRaised: boolean;
  typing: boolean;
  joinedAt: number;
}

export interface FileMeta {
  fileId: string;
  path: string;
  kind: "file" | "dir";
  size: number;
  mtime: number;
  lang: string;
}

export interface ChatMessage {
  id: string;
  participantId: string;
  name: string;
  body: string;
  at: number;
  /** Echo of the optimistic client id so the sender can reconcile. */
  clientMsgId?: string;
}

export interface RoomSnapshot {
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
}

export interface CodeRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface CursorPayload {
  fileId: string;
  line: number;
  column: number;
  topLine?: number;
}

export type WsErrorCode =
  | "UNAUTHENTICATED"
  | "ROOM_NOT_FOUND"
  | "ROOM_LOCKED"
  | "ROOM_ENDED"
  | "NOT_ADMITTED"
  | "FORBIDDEN"
  | "RATE_LIMITED"
  | "PAYLOAD_TOO_LARGE"
  | "INVALID_MESSAGE"
  | "CONFLICT"
  | "FS_NOT_CONNECTED"
  | "FS_TIMEOUT"
  | "PARTICIPANT_LIMIT"
  | "INTERNAL";

export type HostAction =
  | "admit"
  | "admit_all"
  | "deny"
  | "kick"
  | "lock_room"
  | "unlock_room"
  | "set_role"
  | "grant_edit"
  | "revoke_edit"
  | "grant_speak"
  | "revoke_speak"
  | "mute"
  | "ask_unmute"
  | "transfer_host"
  | "end_session"
  | "toggle_admit_mode"
  | "toggle_screen_share"
  | "save_workspace";

export interface ClientPayloads {
  join_room: {
    roomKey: string;
    displayName: string;
    hostToken?: string;
    reconnectToken?: string;
    media: { mic: boolean; cam: boolean };
    client: { supportsFs: boolean; appVersion: string };
  };
  leave_room: { reason?: string };
  yjs_update: { fileId: string; update: string };
  yjs_sync_request: { fileId: string; stateVector?: string };
  cursor_move: CursorPayload;
  selection_change: { fileId: string; ranges: CodeRange[] };
  viewport_change: { fileId: string; topLine: number };
  request_edit: { note?: string };
  request_speak: { enabled: boolean };
  chat_send: { body: string; clientMsgId: string };
  raise_hand: { raised: boolean };
  reaction: { emoji: string };
  file_op: {
    op: "open" | "create" | "mkdir" | "rename" | "delete" | "move";
    fileId?: string;
    path: string;
    toPath?: string;
  };
  webrtc_signal: {
    targetId: string;
    signal:
      | { type: "offer" | "answer"; sdp: string }
      | { type: "candidate"; candidate: RTCIceCandidateInit }
      | { type: "renegotiate" };
  };
  media_state: { mic: boolean; cam: boolean; screen: boolean };
  host_action: {
    action: HostAction;
    targetId?: string;
    payload?: Record<string, unknown>;
  };
  /**
   * Host announces its desktop workspace. File contents are pulled lazily with
   * fs_request/read once somebody opens a file, keeping frames small.
   */
  fs_bridge_attach: {
    connected: boolean;
    rootName: string;
    snapshot: Array<{
      path: string;
      kind: "file" | "dir";
      size: number;
      mtime: number;
    }>;
  };
  fs_file_content: {
    requestId: string;
    fileId: string;
    content: string;
    mtime: number;
  };
  fs_ack: {
    requestId: string;
    ok: boolean;
    error?: string;
    fileId?: string;
    path?: string;
  };
  ping: { t: number };
}

export interface ServerPayloads {
  room_state: {
    room: RoomSnapshot;
    self: Participant;
    participants: Participant[];
    files: FileMeta[];
    chat: ChatMessage[];
    waiting: Participant[];
    serverTime: number;
  };
  participant_joined: { participant: Participant };
  participant_left: {
    participantId: string;
    reason: "left" | "dropped" | "kicked";
  };
  participant_updated: { participant: Participant };
  permission_changed: {
    participantId: string;
    role: Role;
    canEdit: boolean;
    canSpeak: boolean;
    reason: string;
  };
  admitted: { reconnectToken: string; self: Participant };
  denied: { reason: string };
  kicked: { reason: string };
  room_ended: { reason: "host_ended" | "expired" };
  waiting_room: { waiting: Participant[] };
  yjs_sync: { fileId: string; update: string; kind: "snapshot" | "diff" };
  host_action: {
    action: HostAction;
    actorId: string;
    targetId?: string;
    payload?: Record<string, unknown>;
  };
  chat_message: { message: ChatMessage };
  workspace_reset: {
    files: FileMeta[];
    rootName: string | null;
    mode: WorkspaceMode;
  };
  workspace_save: {
    operationId: string;
    phase: "saving" | "success" | "partial" | "empty" | "failed";
    mode: WorkspaceMode;
    total: number;
    saved: number;
    failed: number;
    failures: Array<{ path: string; error: string }>;
  };
  file_changed: {
    op: "create" | "mkdir" | "rename" | "delete" | "move";
    path: string;
    toPath?: string;
    meta?: FileMeta;
  };
  fs_request: {
    requestId: string;
    op: "read" | "write" | "delete" | "mkdir" | "create" | "rename";
    fileId?: string;
    path: string;
    toPath?: string;
    content?: string;
  };
  webrtc_signal: {
    fromId: string;
    signal:
      | { type: "offer" | "answer"; sdp: string }
      | { type: "candidate"; candidate: RTCIceCandidateInit }
      | { type: "renegotiate" };
  };
  reaction: { participantId: string; emoji: string };
  cursor: {
    participantId: string;
    fileId: string;
    line: number;
    column: number;
    topLine?: number;
  };
  selection: { participantId: string; fileId: string; ranges: CodeRange[] };
  viewport: { participantId: string; fileId: string; topLine: number };
  permission_request: {
    participantId: string;
    name: string;
    kind: "edit" | "speak";
    note?: string;
  };
  pong: { t: number; serverTime: number };
  error: { code: WsErrorCode; message: string; requestId?: string };
}

export type ClientType = keyof ClientPayloads;
export type ServerType = keyof ServerPayloads;

export type ClientMessage = {
  [K in ClientType]: Envelope<K & string, ClientPayloads[K]>;
}[ClientType];

export type ServerMessage = {
  [K in ServerType]: Envelope<K & string, ServerPayloads[K]>;
}[ServerType];

export type ServerMessageOf<T extends ServerType> = Extract<
  ServerMessage,
  { type: T }
>;
export type ClientMessageOf<T extends ClientType> = Extract<
  ClientMessage,
  { type: T }
>;

/** WebSocket close codes (4000-4999 are application specific). */
export const WS_CLOSE = {
  AUTH_TIMEOUT: 4001,
  FORBIDDEN: 4003,
  RATE_LIMITED: 4008,
  REPLACED: 4009,
  ROOM_ENDED: 4010,
} as const;

export const REACTION_EMOJIS = ["👍", "🎉", "👀", "❓", "🔥"] as const;
export type ReactionEmoji = (typeof REACTION_EMOJIS)[number];
