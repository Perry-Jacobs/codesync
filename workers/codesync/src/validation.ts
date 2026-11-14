import { z } from "zod";

import {
  MAX_CONTENT_CHARS,
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  REACTION_EMOJIS,
  type ClientMessage,
  type WsErrorCode,
} from "./protocol";

const FILE_ID_RE = /^f_[A-Za-z0-9_-]{10,32}$/;
const ROOM_KEY_RE = /^zk-[A-Za-z0-9_-]{18}$/;
const MAX_UPDATE_CHARS = 280_000; // ~210 KB of binary once decoded

const fileId = z.string().regex(FILE_ID_RE, "invalid file id");
const relativePath = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\0") &&
      !value.includes("\\") &&
      value
        .split("/")
        .every(
          (segment) =>
            segment.length > 0 && segment !== "." && segment !== "..",
        ),
    "invalid relative path",
  );

const envelope = {
  v: z.literal(PROTOCOL_VERSION),
  id: z.string().min(1).max(64),
  ts: z.number().int().nonnegative(),
};

const cursor = z.object({
  fileId,
  line: z.number().int().min(0).max(2_000_000),
  column: z.number().int().min(0).max(100_000),
  topLine: z.number().int().min(0).max(2_000_000).optional(),
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

const signal = z.union([
  z.object({ type: z.enum(["offer", "answer"]), sdp: z.string().max(200_000) }),
  z.object({ type: z.literal("candidate"), candidate: iceCandidate }),
  z.object({ type: z.literal("renegotiate") }),
]);

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

const messageSchema = z.discriminatedUnion("type", [
  z.object({
    ...envelope,
    type: z.literal("join_room"),
    data: z.object({
      roomKey: z.string().regex(ROOM_KEY_RE, "invalid session key"),
      displayName: z.string().trim().min(1).max(48),
      hostToken: z.string().min(16).max(256).optional(),
      reconnectToken: z.string().min(10).max(4000).optional(),
      media: z.object({ mic: z.boolean(), cam: z.boolean() }),
      client: z.object({
        supportsFs: z.boolean(),
        appVersion: z.string().max(32),
      }),
    }),
  }),
  z.object({
    ...envelope,
    type: z.literal("leave_room"),
    data: z.object({ reason: z.string().max(200).optional() }),
  }),
  z.object({
    ...envelope,
    type: z.literal("yjs_update"),
    data: z.object({ fileId, update: z.string().min(4).max(MAX_UPDATE_CHARS) }),
  }),
  z.object({
    ...envelope,
    type: z.literal("yjs_sync_request"),
    data: z.object({
      fileId,
      stateVector: z.string().max(MAX_UPDATE_CHARS).optional(),
    }),
  }),
  z.object({ ...envelope, type: z.literal("cursor_move"), data: cursor }),
  z.object({
    ...envelope,
    type: z.literal("selection_change"),
    data: z.object({ fileId, ranges: z.array(codeRange).max(8) }),
  }),
  z.object({
    ...envelope,
    type: z.literal("viewport_change"),
    data: z.object({ fileId, topLine: z.number().int().min(0).max(2_000_000) }),
  }),
  z.object({
    ...envelope,
    type: z.literal("request_edit"),
    data: z.object({ note: z.string().max(280).optional() }),
  }),
  z.object({
    ...envelope,
    type: z.literal("request_speak"),
    data: z.object({ enabled: z.boolean() }),
  }),
  z.object({
    ...envelope,
    type: z.literal("chat_send"),
    data: z.object({
      body: z
        .string()
        .trim()
        .min(1)
        .max(2000)
        .refine((b) => !b.includes("\0"), "invalid body"),
      clientMsgId: z.string().min(1).max(64),
    }),
  }),
  z.object({
    ...envelope,
    type: z.literal("raise_hand"),
    data: z.object({ raised: z.boolean() }),
  }),
  z.object({
    ...envelope,
    type: z.literal("reaction"),
    data: z.object({ emoji: z.enum(REACTION_EMOJIS) }),
  }),
  z.object({
    ...envelope,
    type: z.literal("file_op"),
    data: z.object({
      op: z.enum(["open", "create", "mkdir", "rename", "delete", "move"]),
      fileId: fileId.optional(),
      path: relativePath,
      toPath: relativePath.optional(),
    }),
  }),
  z.object({
    ...envelope,
    type: z.literal("webrtc_signal"),
    data: z.object({ targetId: z.string().min(1).max(64), signal }),
  }),
  z.object({
    ...envelope,
    type: z.literal("media_state"),
    data: z.object({ mic: z.boolean(), cam: z.boolean(), screen: z.boolean() }),
  }),
  z.object({
    ...envelope,
    type: z.literal("host_action"),
    data: z.object({
      action: hostAction,
      targetId: z.string().max(64).optional(),
      payload: z
        .record(
          z.string(),
          z.union([z.string().max(512), z.number(), z.boolean(), z.null()]),
        )
        .optional(),
    }),
  }),
  z.object({
    ...envelope,
    type: z.literal("fs_bridge_attach"),
    data: z.object({
      connected: z.boolean(),
      rootName: z.string().max(120),
      snapshot: z
        .array(
          z.object({
            path: relativePath,
            kind: z.enum(["file", "dir"]),
            size: z.number().int().min(0).max(2_000_000),
            mtime: z.number().int().min(0),
          }),
        )
        .max(600),
    }),
  }),
  z.object({
    ...envelope,
    type: z.literal("fs_file_content"),
    data: z.object({
      requestId: z.string().min(1).max(64),
      fileId,
      content: z.string().max(MAX_CONTENT_CHARS),
      mtime: z.number().int().min(0),
    }),
  }),
  z.object({
    ...envelope,
    type: z.literal("fs_ack"),
    data: z.object({
      requestId: z.string().min(1).max(64),
      ok: z.boolean(),
      error: z.string().max(500).optional(),
      fileId: fileId.optional(),
      path: relativePath.optional(),
    }),
  }),
  z.object({
    ...envelope,
    type: z.literal("ping"),
    data: z.object({ t: z.number().int().nonnegative() }),
  }),
]);

export type ParsedClientMessage = z.infer<typeof messageSchema>;

export type ParseClientMessageResult =
  | { ok: true; message: ClientMessage }
  | { ok: false; code: WsErrorCode; detail: string };

export function parseClientMessage(raw: string): ParseClientMessageResult {
  if (new TextEncoder().encode(raw).byteLength > MAX_MESSAGE_BYTES) {
    return {
      ok: false,
      code: "PAYLOAD_TOO_LARGE",
      detail: "frame exceeds 480k bytes",
    };
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return { ok: false, code: "INVALID_MESSAGE", detail: "malformed JSON" };
  }
  const result = messageSchema.safeParse(parsedJson);
  if (!result.success) {
    const detail = result.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    return { ok: false, code: "INVALID_MESSAGE", detail };
  }
  // The zod schema is the runtime mirror of ClientPayloads; the cast is safe.
  return { ok: true, message: result.data as ClientMessage };
}
