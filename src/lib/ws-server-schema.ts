import { z } from "zod";
import {
  MAX_CONTENT_CHARS,
  PROTOCOL_VERSION,
  REACTION_EMOJIS,
  type ServerMessage,
} from "./ws-protocol";

const COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
const ROOM_KEY_RE = /^zk-[A-Za-z0-9_-]{18}$/;
const FILE_ID_RE = /^f_[A-Za-z0-9_-]{10,32}$/;

const role = z.enum(["HOST", "CO_HOST", "EDITOR", "VIEWER", "GUEST"]);
const participantState = z.enum([
  "WAITING",
  "ADMITTED",
  "LEFT",
  "REMOVED",
  "DENIED",
]);
const roomStatus = z.enum(["open", "locked", "ended"]);
const admitMode = z.enum(["auto", "manual"]);
const workspaceMode = z.enum(["virtual", "local-fs"]);
const hostAction = z.enum([
  "admit",
  "admit_all",
  "deny",
  "kick",
  "lock_room",
  "unlock_room",
  "set_role",
  "grant_edit",
  "revoke_edit",
  "grant_speak",
  "revoke_speak",
  "mute",
  "ask_unmute",
  "transfer_host",
  "end_session",
  "toggle_admit_mode",
  "toggle_screen_share",
  "save_workspace",
]);
const errorCode = z.enum([
  "UNAUTHENTICATED",
  "ROOM_NOT_FOUND",
  "ROOM_LOCKED",
  "ROOM_ENDED",
  "NOT_ADMITTED",
  "FORBIDDEN",
  "RATE_LIMITED",
  "PAYLOAD_TOO_LARGE",
  "INVALID_MESSAGE",
  "CONFLICT",
  "FS_NOT_CONNECTED",
  "FS_TIMEOUT",
  "PARTICIPANT_LIMIT",
  "INTERNAL",
]);

const envelope = {
  v: z.literal(PROTOCOL_VERSION),
  id: z.string().min(1).max(64),
  ts: z.number().int().nonnegative(),
};

const participant = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(48),
  role,
  color: z.string().regex(COLOR_RE, "invalid participant color"),
  state: participantState,
  canEdit: z.boolean(),
  canSpeak: z.boolean(),
  mic: z.boolean(),
  cam: z.boolean(),
  screen: z.boolean(),
  handRaised: z.boolean(),
  typing: z.boolean(),
  joinedAt: z.number().int().nonnegative(),
});

const fileMeta = z.object({
  fileId: z.string().regex(FILE_ID_RE, "invalid file id"),
  path: z.string().min(1).max(512),
  kind: z.enum(["file", "dir"]),
  size: z.number().int().nonnegative(),
  mtime: z.number().int().nonnegative(),
  lang: z.string().max(64),
});

const chatMessage = z.object({
  id: z.string().min(1).max(64),
  participantId: z.string().min(1).max(64),
  name: z.string().min(1).max(48),
  body: z.string().min(1).max(2000),
  at: z.number().int().nonnegative(),
  clientMsgId: z.string().min(1).max(64).optional(),
});

const roomSnapshot = z.object({
  id: z.string().min(1).max(64),
  key: z.string().regex(ROOM_KEY_RE),
  title: z.string().min(1).max(120),
  status: roomStatus,
  admitMode,
  hostParticipantId: z.string().min(1).max(64),
  allowGuestScreenShare: z.boolean(),
  maxParticipants: z.number().int().positive().max(1000),
  workspaceMode,
  rootName: z.string().max(120).nullable(),
  createdAt: z.number().int().nonnegative(),
});

const codeRange = z.object({
  startLine: z.number().int().min(0).max(2_000_000),
  startColumn: z.number().int().min(0).max(100_000),
  endLine: z.number().int().min(0).max(2_000_000),
  endColumn: z.number().int().min(0).max(100_000),
});

const iceCandidate = z.object({
  candidate: z.string().max(2048),
  sdpMid: z.string().max(64).nullish(),
  sdpMLineIndex: z.number().int().nullish(),
  usernameFragment: z.string().max(256).nullish(),
});
const signal = z.discriminatedUnion("type", [
  z.object({ type: z.enum(["offer", "answer"]), sdp: z.string().max(200_000) }),
  z.object({ type: z.literal("candidate"), candidate: iceCandidate }),
  z.object({ type: z.literal("renegotiate") }),
]);

export const serverMessageSchema = z.discriminatedUnion("type", [
  z.object({
    ...envelope,
    type: z.literal("room_state"),
    data: z.object({
      room: roomSnapshot,
      self: participant,
      participants: z.array(participant).max(1000),
      files: z.array(fileMeta).max(600),
      chat: z.array(chatMessage).max(300),
      waiting: z.array(participant).max(1000),
      serverTime: z.number().int().nonnegative(),
    }),
  }),
  z.object({
    ...envelope,
    type: z.literal("participant_joined"),
    data: z.object({ participant }),
  }),
  z.object({
    ...envelope,
    type: z.literal("participant_left"),
    data: z.object({
      participantId: z.string().min(1).max(64),
      reason: z.enum(["left", "dropped", "kicked"]),
    }),
  }),
  z.object({
    ...envelope,
    type: z.literal("participant_updated"),
    data: z.object({ participant }),
  }),
  z.object({
    ...envelope,
    type: z.literal("permission_changed"),
    data: z.object({
      participantId: z.string().min(1).max(64),
      role,
      canEdit: z.boolean(),
      canSpeak: z.boolean(),
      reason: z.string().max(500),
    }),
  }),
  z.object({
    ...envelope,
    type: z.literal("admitted"),
    data: z.object({
      reconnectToken: z.string().min(10).max(4000),
      self: participant,
    }),
  }),
  z.object({
    ...envelope,
    type: z.literal("denied"),
    data: z.object({ reason: z.string().max(500) }),
  }),
  z.object({
    ...envelope,
    type: z.literal("kicked"),
    data: z.object({ reason: z.string().max(500) }),
  }),
  z.object({
    ...envelope,
    type: z.literal("room_ended"),
    data: z.object({ reason: z.enum(["host_ended", "expired"]) }),
  }),
  z.object({
    ...envelope,
    type: z.literal("waiting_room"),
    data: z.object({ waiting: z.array(participant).max(1000) }),
  }),
  z.object({
    ...envelope,
    type: z.literal("yjs_sync"),
    data: z.object({
      fileId: z.string().regex(FILE_ID_RE),
      update: z.string().min(1).max(MAX_CONTENT_CHARS),
      kind: z.enum(["snapshot", "diff"]),
    }),
  }),
  z.object({
    ...envelope,
    type: z.literal("host_action"),
    data: z.object({
      action: hostAction,
      actorId: z.string().min(1).max(64),
      targetId: z.string().min(1).max(64).optional(),
      payload: z.record(z.string(), z.unknown()).optional(),
    }),
  }),
  z.object({
    ...envelope,
    type: z.literal("chat_message"),
    data: z.object({ message: chatMessage }),
  }),
  z.object({
    ...envelope,
    type: z.literal("workspace_save"),
    data: z.object({
      operationId: z.string().min(1).max(64),
      phase: z.enum(["saving", "success", "partial", "empty", "failed"]),
      mode: workspaceMode,
      total: z.number().int().nonnegative(),
      saved: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      failures: z
        .array(
          z.object({
            path: z.string().min(1).max(512),
            error: z.string().min(1).max(500),
          }),
        )
        .max(600),
    }),
  }),
  z.object({
    ...envelope,
    type: z.literal("workspace_reset"),
    data: z.object({
      files: z.array(fileMeta).max(600),
      rootName: z.string().max(120).nullable(),
      mode: workspaceMode,
    }),
  }),
  z.object({
    ...envelope,
    type: z.literal("file_changed"),
    data: z.object({
      op: z.enum(["create", "mkdir", "rename", "delete", "move"]),
      path: z.string().min(1).max(512),
      toPath: z.string().min(1).max(512).optional(),
      meta: fileMeta.optional(),
    }),
  }),
  z.object({
    ...envelope,
    type: z.literal("fs_request"),
    data: z.object({
      requestId: z.string().min(1).max(64),
      op: z.enum(["read", "write", "delete", "mkdir", "create", "rename"]),
      fileId: z.string().regex(FILE_ID_RE).optional(),
      path: z.string().min(1).max(512),
      toPath: z.string().min(1).max(512).optional(),
      content: z.string().max(MAX_CONTENT_CHARS).optional(),
    }),
  }),
  z.object({
    ...envelope,
    type: z.literal("webrtc_signal"),
    data: z.object({ fromId: z.string().min(1).max(64), signal }),
  }),
  z.object({
    ...envelope,
    type: z.literal("reaction"),
    data: z.object({
      participantId: z.string().min(1).max(64),
      emoji: z.enum(REACTION_EMOJIS),
    }),
  }),
  z.object({
    ...envelope,
    type: z.literal("cursor"),
    data: z.object({
      participantId: z.string().min(1).max(64),
      fileId: z.string().regex(FILE_ID_RE),
      line: z.number().int().min(0).max(2_000_000),
      column: z.number().int().min(0).max(100_000),
      topLine: z.number().int().min(0).max(2_000_000).optional(),
    }),
  }),
  z.object({
    ...envelope,
    type: z.literal("selection"),
    data: z.object({
      participantId: z.string().min(1).max(64),
      fileId: z.string().regex(FILE_ID_RE),
      ranges: z.array(codeRange).max(8),
    }),
  }),
  z.object({
    ...envelope,
    type: z.literal("viewport"),
    data: z.object({
      participantId: z.string().min(1).max(64),
      fileId: z.string().regex(FILE_ID_RE),
      topLine: z.number().int().min(0).max(2_000_000),
    }),
  }),
  z.object({
    ...envelope,
    type: z.literal("permission_request"),
    data: z.object({
      participantId: z.string().min(1).max(64),
      name: z.string().min(1).max(48),
      kind: z.enum(["edit", "speak"]),
      note: z.string().max(280).optional(),
    }),
  }),
  z.object({
    ...envelope,
    type: z.literal("pong"),
    data: z.object({
      t: z.number().int().nonnegative(),
      serverTime: z.number().int().nonnegative(),
    }),
  }),
  z.object({
    ...envelope,
    type: z.literal("error"),
    data: z.object({
      code: errorCode,
      message: z.string().max(1000),
      requestId: z.string().max(64).optional(),
    }),
  }),
]);

export type ParsedServerMessage = z.infer<typeof serverMessageSchema>;

export function parseServerMessage(
  raw: string,
): { ok: true; message: ServerMessage } | { ok: false; detail: string } {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, detail: "malformed JSON" };
  }
  const parsed = serverMessageSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      detail: parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; "),
    };
  }
  return { ok: true, message: parsed.data as ServerMessage };
}
