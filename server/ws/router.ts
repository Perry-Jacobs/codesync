import { parseClientMessage } from "@/lib/ws-schemas";
import type { ClientMessage } from "@/lib/ws-protocol";
import { WsError } from "../errors";
import { createLogger } from "../logger";
import { touchRoom } from "../rooms/repository";
import { quotaErrorMessage } from "../rate-limit";
import type { SocketContext } from "./connection";
import { handleJoinRoom, handleLeaveRoom } from "./handlers/room";
import { handleHostAction, handlePermissionRequest } from "./handlers/host";
import {
  handleCursorMove,
  handleFileSyncRequest,
  handleSelectionChange,
  handleViewportChange,
  handleYjsUpdate,
} from "./handlers/code";
import {
  handleChatSend,
  handleMediaState,
  handleRaiseHand,
  handleReaction,
} from "./handlers/chat";
import { handleWebrtcSignal } from "./handlers/media";
import {
  handleBridgeAttach,
  handleFileOp,
  handleFsAck,
  handleFsFileContent,
} from "./handlers/fs";
import { handlePing } from "./handlers/system";

const log = createLogger({ scope: "router" });

async function dispatch(
  ctx: SocketContext,
  message: ClientMessage,
): Promise<void> {
  switch (message.type) {
    case "join_room":
      await handleJoinRoom(ctx, message.data);
      return;
    case "leave_room":
      await handleLeaveRoom(ctx);
      return;
    case "yjs_update":
      await handleYjsUpdate(ctx, message.data);
      return;
    case "yjs_sync_request":
      await handleFileSyncRequest(ctx, message.data);
      return;
    case "cursor_move":
      await handleCursorMove(ctx, message.data);
      return;
    case "selection_change":
      await handleSelectionChange(ctx, message.data);
      return;
    case "viewport_change":
      await handleViewportChange(ctx, message.data);
      return;
    case "request_edit":
      await handlePermissionRequest(ctx, "edit", message.data.note);
      return;
    case "request_speak":
      await handlePermissionRequest(ctx, "speak");
      return;
    case "chat_send":
      await handleChatSend(ctx, message.data);
      return;
    case "raise_hand":
      await handleRaiseHand(ctx, message.data);
      return;
    case "reaction":
      await handleReaction(ctx, message.data);
      return;
    case "media_state":
      await handleMediaState(ctx, message.data);
      return;
    case "file_op":
      await handleFileOp(ctx, message.data);
      return;
    case "webrtc_signal":
      await handleWebrtcSignal(ctx, message.data);
      return;
    case "host_action":
      await handleHostAction(ctx, message.data);
      return;
    case "fs_bridge_attach":
      await handleBridgeAttach(ctx, message.data);
      return;
    case "fs_file_content":
      await handleFsFileContent(ctx, message.data);
      return;
    case "fs_ack":
      await handleFsAck(ctx, message.data);
      return;
    case "ping":
      await handlePing(ctx, message.data);
      return;
    default:
      throw new WsError("INVALID_MESSAGE", "Unsupported message type");
  }
}

export async function routeMessage(
  ctx: SocketContext,
  raw: string,
): Promise<void> {
  const parsed = parseClientMessage(raw);
  if (!parsed.ok) {
    ctx.send("error", { code: parsed.code, message: parsed.detail });
    return;
  }
  const message = parsed.message;

  if (!ctx.bucket.take()) {
    ctx.violations += 1;
    ctx.send("error", {
      code: "RATE_LIMITED",
      message: "Too many messages, slow down",
    });
    if (ctx.violations > 20) ctx.close(4008, "Rate limit exceeded");
    return;
  }

  if (!ctx.quotas.check(message.type)) {
    ctx.violations += 1;
    ctx.send("error", {
      code: "RATE_LIMITED",
      message: quotaErrorMessage(message.type),
    });
    if (ctx.violations > 30) ctx.close(4008, "Rate limit exceeded");
    return;
  }

  // Reject everything except the handshake (and liveness ping) before join.
  if (message.type !== "join_room" && message.type !== "ping" && !ctx.joined) {
    ctx.send("error", {
      code: "UNAUTHENTICATED",
      message: "Join a room first",
    });
    return;
  }

  if (message.type === "join_room" && ctx.joined) {
    ctx.send("error", {
      code: "CONFLICT",
      message: "This socket already joined a room",
    });
    return;
  }

  if (ctx.roomId) void touchRoom(ctx.roomId);

  try {
    await dispatch(ctx, message);
    if (ctx.violations > 0) ctx.violations = Math.max(0, ctx.violations - 1);
  } catch (error) {
    if (error instanceof WsError) {
      ctx.send("error", { code: error.code, message: error.message });
      return;
    }
    log.error("handler crashed", {
      type: message.type,
      roomId: ctx.roomId,
      participantId: ctx.participant?.id,
      error:
        error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
    ctx.send("error", {
      code: "INTERNAL",
      message: "Something went wrong on the server",
    });
  }
}
