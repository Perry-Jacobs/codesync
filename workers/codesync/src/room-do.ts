import {
  canAssignRole,
  canEndSession,
  canKick,
  canManageParticipant,
  canScreenShare,
  canTransferHost,
  defaultsForRole,
  hasCapability,
} from "./acl";
import { base64ToBytes, randomToken, safeEqual, sha256Hex } from "./crypto";
import type { Env } from "./env";
import {
  PROTOCOL_VERSION,
  WS_CLOSE,
  type ChatMessage,
  type ClientMessage,
  type ClientPayloads,
  type FileMeta,
  type Participant,
  type Role,
  type ServerPayloads,
} from "./protocol";
import { parseClientMessage } from "./validation";
import {
  clearAllPresence,
  clearFilePresence,
  clearParticipantPresence,
  prunePresenceSnapshots,
  type FilePresenceState,
  updatePresenceSnapshot,
} from "./presence-state";
import {
  addFileSubscription,
  clearFileSubscriptions,
  removeFileSubscription,
} from "./file-subscriptions";
import { moveWorkspacePath } from "./workspace-paths";
import {
  workspaceMoveConflict,
  workspacePathConflict,
} from "./workspace-paths";

interface RoomRecord {
  id: string;
  key: string;
  title: string;
  status: "open" | "locked" | "ended";
  admitMode: "auto" | "manual";
  hostParticipantId: string;
  allowGuestScreenShare: boolean;
  maxParticipants: number;
  workspaceMode: "virtual" | "local-fs";
  rootName: string | null;
  createdAt: number;
  lastActivityAt: number;
}

interface ParticipantRecord extends Participant {
  socketId: string | null;
  lastSeenAt: number;
}

interface HostCredential {
  participantId: string;
  tokenHash: string;
}

interface ReconnectCredential {
  participantId: string;
  expiresAt: number;
}

interface PendingFsRequest {
  requestId: string;
  op: "read" | "write" | "delete" | "mkdir" | "create" | "rename";
  requesterId: string;
  fileId?: string;
  path: string;
  toPath?: string;
  content?: string;
  createdAt: number;
}

interface DurableRoomState {
  room: RoomRecord;
  participants: Record<string, ParticipantRecord>;
  waiting: string[];
  chat: ChatMessage[];
  files: FileMeta[];
  hostCredential: HostCredential | null;
  reconnectCredentials: Record<string, ReconnectCredential>;
  pendingFs: Record<string, PendingFsRequest>;
}

interface SocketAttachment {
  socketId: string;
  participantId?: string;
  files: string[];
  messageCount: number;
  rateStartedAt: number;
  presence?: FilePresenceState;
}

interface CreateRoomBody {
  key?: string;
  hostName?: string;
  title?: string;
  admitMode?: "auto" | "manual";
}

interface FsResponse {
  ok: boolean;
  content?: string;
  error?: string;
  fileId?: string;
  path?: string;
  mtime?: number;
}

const STATE_KEY = "room-state";
const MAX_CHAT_MESSAGES = 200;
const FS_TIMEOUT_MS = 8_000;
const MESSAGE_RATE_LIMIT = 240;

export class RoomDurableObject {
  private readonly pendingResponses = new Map<
    string,
    {
      resolve: (value: FsResponse) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
        return this.acceptWebSocket(request, url);
      }
      if (request.method === "POST" && url.pathname === "/internal/create") {
        return this.createRoom((await request.json()) as CreateRoomBody);
      }
      if (request.method === "GET" && url.pathname === "/internal/info") {
        return this.roomInfo();
      }
      return json({ error: "Not found", code: "NOT_FOUND" }, 404);
    } catch (error) {
      console.error("Durable Object room operation failed", error);
      return json({ error: "Room operation failed", code: "INTERNAL" }, 500);
    }
  }

  async webSocketMessage(
    webSocket: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    if (typeof message !== "string") {
      this.sendError(
        webSocket,
        "INVALID_MESSAGE",
        "Binary frames are not supported",
      );
      return;
    }
    const attachment = this.attachment(webSocket);
    if (!this.allowMessage(webSocket, attachment)) {
      this.sendError(webSocket, "RATE_LIMITED", "Too many messages");
      webSocket.close(WS_CLOSE.RATE_LIMITED, "Rate limited");
      return;
    }

    const parsed = parseClientMessage(message);
    if (!parsed.ok) {
      this.sendError(webSocket, parsed.code, parsed.detail);
      return;
    }
    if (
      !attachment.participantId &&
      parsed.message.type !== "join_room" &&
      parsed.message.type !== "ping"
    ) {
      this.sendError(webSocket, "UNAUTHENTICATED", "Join a room first");
      return;
    }
    if (attachment.participantId && parsed.message.type === "join_room") {
      this.sendError(
        webSocket,
        "CONFLICT",
        "This socket already joined a room",
      );
      return;
    }
    try {
      await this.handleMessage(webSocket, parsed.message);
    } catch (error) {
      const requestId = parsed.message.id;
      const known = error instanceof RoomError ? error : null;
      this.sendError(
        webSocket,
        known?.code ?? "INTERNAL",
        known?.message ?? "The request could not be completed",
        requestId,
      );
    }
  }

  async webSocketClose(
    webSocket: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    const attachment = this.attachment(webSocket);
    if (!attachment.participantId) return;
    const participantId = attachment.participantId;
    const changed = await this.updateState((state) => {
      const participant = state.participants[participantId];
      if (!participant || participant.socketId !== this.socketId(webSocket))
        return null;
      const wasWaiting = participant.state === "WAITING";
      participant.socketId = null;
      participant.mic = false;
      participant.cam = false;
      participant.screen = false;
      participant.typing = false;
      participant.handRaised = false;
      participant.lastSeenAt = Date.now();
      state.room.lastActivityAt = Date.now();
      if (wasWaiting) {
        state.waiting = state.waiting.filter((id) => id !== participantId);
        delete state.participants[participantId];
        for (const [hash, credential] of Object.entries(
          state.reconnectCredentials,
        )) {
          if (credential.participantId === participantId)
            delete state.reconnectCredentials[hash];
        }
      }
      return participant;
    });
    if (changed) {
      this.clearParticipantPresence(participantId);
      this.clearParticipantFileSubscriptions(participantId);
      if (changed.state === "WAITING") {
        await this.broadcast("waiting_room", {
          waiting: await this.waitingParticipants(),
        });
      } else {
        await this.broadcast("participant_left", {
          participantId,
          reason: "dropped",
        });
      }
    }
  }

  async alarm(): Promise<void> {
    for (const webSocket of this.ctx.getWebSockets()) {
      const attachment = this.attachment(webSocket);
      if (!attachment.participantId) {
        webSocket.close(WS_CLOSE.AUTH_TIMEOUT, "Authentication timeout");
      }
    }
  }

  private acceptWebSocket(request: Request, url: URL): Response {
    const expectedKey = url.searchParams.get("room")?.trim();
    if (!expectedKey || !/^zk-[A-Za-z0-9_-]{18}$/.test(expectedKey)) {
      return json({ error: "Invalid room key", code: "BAD_REQUEST" }, 400);
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, [expectedKey]);
    server.serializeAttachment({
      socketId: randomToken(12),
      participantId: undefined,
      files: [],
      messageCount: 0,
      rateStartedAt: Date.now(),
    } satisfies SocketAttachment);
    void this.ctx.storage.setAlarm(Date.now() + 15_000);
    void request;
    return new Response(null, { status: 101, webSocket: client });
  }

  private async createRoom(body: CreateRoomBody): Promise<Response> {
    if (!body.key || !/^zk-[A-Za-z0-9_-]{18}$/.test(body.key)) {
      return json({ error: "Invalid room key", code: "BAD_REQUEST" }, 400);
    }
    const hostName = body.hostName?.trim().slice(0, 48) || "Host";
    const now = Date.now();
    const roomId = `r_${randomToken(12)}`;
    const hostId = `p_${randomToken(12)}`;
    const hostToken = randomToken();
    const hostHash = await sha256Hex(hostToken);
    const maxParticipants = this.maxParticipants();
    const room: RoomRecord = {
      id: roomId,
      key: body.key,
      title: body.title?.trim().slice(0, 80) || "Untitled workspace",
      status: "open",
      admitMode: body.admitMode === "manual" ? "manual" : "auto",
      hostParticipantId: hostId,
      allowGuestScreenShare: false,
      maxParticipants,
      workspaceMode: "virtual",
      rootName: null,
      createdAt: now,
      lastActivityAt: now,
    };
    const grants = defaultsForRole("HOST");
    const host: ParticipantRecord = {
      id: hostId,
      name: hostName,
      role: "HOST",
      color: this.pickColor(0),
      state: "ADMITTED",
      canEdit: grants.canEdit,
      canSpeak: grants.canSpeak,
      mic: false,
      cam: false,
      screen: false,
      handRaised: false,
      typing: false,
      joinedAt: now,
      socketId: null,
      lastSeenAt: now,
    };
    const state: DurableRoomState = {
      room,
      participants: { [hostId]: host },
      waiting: [],
      chat: [],
      files: [],
      hostCredential: {
        participantId: hostId,
        tokenHash: hostHash,
      },
      reconnectCredentials: {},
      pendingFs: {},
    };
    const exists = await this.ctx.storage.get<DurableRoomState>(STATE_KEY);
    if (exists)
      return json({ error: "Room already exists", code: "CONFLICT" }, 409);
    await this.ctx.storage.put(STATE_KEY, state);
    return json({
      roomKey: room.key,
      roomId: room.id,
      hostToken,
      hostName: host.name,
      title: room.title,
    });
  }

  private async roomInfo(): Promise<Response> {
    const state = await this.readState();
    if (!state)
      return json({ error: "Room not found", code: "NOT_FOUND" }, 404);
    const host = state.participants[state.room.hostParticipantId];
    const participants = Object.values(state.participants).filter(
      (participant) => participant.state === "ADMITTED" && participant.socketId,
    );
    return json({
      key: state.room.key,
      title: state.room.title,
      status: state.room.status,
      admitMode: state.room.admitMode,
      workspaceMode: state.room.workspaceMode,
      rootName: state.room.rootName,
      hostName: host?.name ?? "Host",
      participantCount: participants.length,
      waitingCount: state.waiting.length,
      maxParticipants: state.room.maxParticipants,
      createdAt: state.room.createdAt,
    });
  }

  private async handleMessage(
    webSocket: WebSocket,
    message: ClientMessage,
  ): Promise<void> {
    if (message.type === "join_room") {
      await this.joinRoom(webSocket, message.data);
      return;
    }
    if (message.type === "ping") {
      this.send(webSocket, "pong", {
        t: message.data.t,
        serverTime: Date.now(),
      });
      return;
    }
    const actor = await this.requireActor(webSocket);
    switch (message.type) {
      case "leave_room":
        await this.leaveRoom(webSocket, actor.id);
        webSocket.close(1000, "Left session");
        return;
      case "chat_send":
        await this.handleChat(actor, message.data);
        return;
      case "raise_hand":
        await this.updateParticipant(actor.id, {
          handRaised: message.data.raised,
        });
        await this.broadcast("participant_updated", {
          participant: await this.wireParticipant(actor.id),
        });
        return;
      case "reaction":
        await this.broadcast("reaction", {
          participantId: actor.id,
          emoji: message.data.emoji,
        });
        return;
      case "media_state":
        await this.handleMediaState(actor, message.data);
        return;
      case "cursor_move":
      case "selection_change":
      case "viewport_change":
        await this.handlePresence(webSocket, actor, message);
        return;
      case "request_edit":
        await this.sendPermissionRequests(actor, "edit", message.data.note);
        return;
      case "request_speak":
        await this.sendPermissionRequests(actor, "speak");
        return;
      case "webrtc_signal":
        await this.handleWebrtc(actor, message.data);
        return;
      case "yjs_update":
        await this.handleYjsUpdate(webSocket, actor, message.data);
        return;
      case "yjs_sync_request":
        await this.handleYjsSync(webSocket, actor, message.data);
        return;
      case "file_op":
        await this.handleFileOp(webSocket, actor, message.data);
        return;
      case "fs_bridge_attach":
        await this.handleBridgeAttach(actor, message.data);
        return;
      case "fs_file_content":
        await this.handleFsResponse(actor, "fs_file_content", message.data);
        return;
      case "fs_ack":
        await this.handleFsResponse(actor, "fs_ack", message.data);
        return;
      case "host_action":
        await this.handleHostAction(actor, message.data);
        return;
    }
  }

  private async joinRoom(
    webSocket: WebSocket,
    data: ClientPayloads["join_room"],
  ): Promise<void> {
    const attachment = this.attachment(webSocket);
    if (attachment.participantId) {
      throw new RoomError("INVALID_MESSAGE", "Socket already joined a room");
    }
    const state = await this.readState();
    if (!state)
      throw new RoomError("ROOM_NOT_FOUND", "No session exists for that key");
    if (state.room.status === "ended")
      throw new RoomError("ROOM_ENDED", "The host ended this session");
    if (data.roomKey !== state.room.key) {
      throw new RoomError(
        "CONFLICT",
        "Room key does not match this connection",
      );
    }

    const reconnectHash = data.reconnectToken
      ? await sha256Hex(data.reconnectToken)
      : null;
    const hostHash = data.hostToken ? await sha256Hex(data.hostToken) : null;
    const now = Date.now();
    const reconnectToken = randomToken();
    const reconnectHashNew = await sha256Hex(reconnectToken);

    const outcome = await this.ctx.storage.transaction(async (txn) => {
      const current = await txn.get<DurableRoomState>(STATE_KEY);
      if (!current)
        throw new RoomError("ROOM_NOT_FOUND", "No session exists for that key");
      if (current.room.status === "ended")
        throw new RoomError("ROOM_ENDED", "The host ended this session");

      let participant: ParticipantRecord | undefined;
      if (reconnectHash) {
        const credential = current.reconnectCredentials[reconnectHash];
        if (!credential || credential.expiresAt < now) {
          if (credential) delete current.reconnectCredentials[reconnectHash];
          throw new RoomError(
            "UNAUTHENTICATED",
            "This reconnect session is invalid or has expired",
          );
        }
        participant = current.participants[credential.participantId];
        if (
          !participant ||
          participant.state === "REMOVED" ||
          participant.state === "DENIED"
        ) {
          throw new RoomError(
            "FORBIDDEN",
            "This participant can no longer rejoin the session",
          );
        }
        // Reconnect tokens stay valid for their full lifetime. Consuming them
        // on first use used to strand a tab whose replacement token was lost
        // when the socket dropped mid-handshake (the client would retry with
        // the already-consumed token and be locked out). Every join still
        // rotates in a fresh token; old ones simply age out.
      } else if (
        hostHash &&
        current.hostCredential &&
        current.hostCredential.participantId ===
          current.room.hostParticipantId &&
        safeEqual(current.hostCredential.tokenHash, hostHash)
      ) {
        // The host credential is reusable for the lifetime of the room. It
        // stays bound to the current host participant, and transfer_host
        // rotates it, so a demoted or transferred host cannot reclaim the
        // role with an old token. Consuming it here used to strand a host who
        // reopened the room after losing the tab's reconnect token.
        const candidate =
          current.participants[current.hostCredential.participantId];
        if (candidate?.state === "ADMITTED") participant = candidate;
      }

      if (participant) {
        this.evictSocket(participant.socketId, this.socketId(webSocket));
        participant.socketId = this.socketId(webSocket);
        participant.mic = participant.canSpeak ? data.media.mic : false;
        participant.cam = data.media.cam;
        participant.screen = false;
        participant.typing = false;
        participant.lastSeenAt = now;
        current.participants[participant.id] = participant;
        current.room.lastActivityAt = now;
        this.rememberReconnectToken(
          current,
          reconnectHashNew,
          participant.id,
          now,
        );
        await txn.put(STATE_KEY, current);
        return {
          participant,
          waiting: participant.state === "WAITING",
          reconnectToken,
          rejoined: true,
        };
      }

      if (current.room.status === "locked") {
        throw new RoomError("ROOM_LOCKED", "The host locked this session");
      }
      // A dropped participant keeps their seat briefly so a reconnect token can
      // restore the same identity. Once that grace window has elapsed the
      // record must not linger in the roster or hold capacity forever.
      const staleBefore = now - 60_000;
      for (const [staleId, stale] of Object.entries(current.participants)) {
        if (
          stale.id === current.room.hostParticipantId ||
          stale.state !== "ADMITTED" ||
          stale.socketId !== null ||
          stale.lastSeenAt >= staleBefore
        ) {
          continue;
        }
        delete current.participants[staleId];
        for (const [hash, credential] of Object.entries(
          current.reconnectCredentials,
        )) {
          if (credential.participantId === staleId)
            delete current.reconnectCredentials[hash];
        }
      }
      const admitted = Object.values(current.participants).filter(
        (entry) => entry.state === "ADMITTED" && entry.socketId,
      );
      if (admitted.length >= current.room.maxParticipants) {
        throw new RoomError(
          "PARTICIPANT_LIMIT",
          `This session is full (${current.room.maxParticipants} max)`,
        );
      }
      if (
        current.room.admitMode === "manual" &&
        current.waiting.length >= current.room.maxParticipants
      ) {
        throw new RoomError("PARTICIPANT_LIMIT", "The waiting room is full");
      }
      const waiting = current.room.admitMode === "manual";
      const participantId = `p_${randomToken(12)}`;
      const usedNames = Object.values(current.participants)
        .filter(
          (entry) =>
            (entry.state === "WAITING" || entry.state === "ADMITTED") &&
            entry.socketId,
        )
        .map((entry) => entry.name.toLocaleLowerCase());
      const newParticipant: ParticipantRecord = {
        id: participantId,
        name: this.uniqueName(data.displayName, usedNames),
        role: waiting ? "GUEST" : "VIEWER",
        color: this.pickColor(admitted.length + current.waiting.length),
        state: waiting ? "WAITING" : "ADMITTED",
        canEdit: false,
        canSpeak: false,
        mic: false,
        cam: waiting ? false : data.media.cam,
        screen: false,
        handRaised: false,
        typing: false,
        joinedAt: now,
        socketId: this.socketId(webSocket),
        lastSeenAt: now,
      };
      current.participants[participantId] = newParticipant;
      if (waiting) current.waiting.push(participantId);
      current.room.lastActivityAt = now;
      if (!waiting) {
        this.rememberReconnectToken(
          current,
          reconnectHashNew,
          participantId,
          now,
        );
      }
      await txn.put(STATE_KEY, current);
      return {
        participant: newParticipant,
        waiting,
        reconnectToken,
        rejoined: false,
      };
    });

    const attachmentUpdate = this.attachment(webSocket);
    attachmentUpdate.participantId = outcome.participant.id;
    webSocket.serializeAttachment(attachmentUpdate satisfies SocketAttachment);

    this.send(
      webSocket,
      "room_state",
      await this.roomState(outcome.participant.id),
    );
    if (outcome.waiting) {
      await this.broadcast("waiting_room", {
        waiting: await this.waitingParticipants(),
      });
      return;
    }
    this.send(webSocket, "admitted", {
      reconnectToken: outcome.reconnectToken,
      self: toWire(outcome.participant),
    });
    await this.broadcast(
      outcome.rejoined ? "participant_updated" : "participant_joined",
      { participant: toWire(outcome.participant) },
      this.socketId(webSocket),
    );
  }

  private async requireActor(webSocket: WebSocket): Promise<ParticipantRecord> {
    const participantId = this.attachment(webSocket).participantId;
    if (!participantId)
      throw new RoomError("UNAUTHENTICATED", "Join a room first");
    const state = await this.readState();
    const participant = state?.participants[participantId];
    if (!state || !participant)
      throw new RoomError("ROOM_NOT_FOUND", "Room no longer exists");
    if (state.room.status === "ended")
      throw new RoomError("ROOM_ENDED", "The session has ended");
    if (participant.state !== "ADMITTED")
      throw new RoomError("NOT_ADMITTED", "You are not admitted to this room");
    if (participant.socketId !== this.socketId(webSocket)) {
      throw new RoomError(
        "FORBIDDEN",
        "This connection was resumed or replaced in another session",
      );
    }
    return participant;
  }

  private async leaveRoom(
    webSocket: WebSocket,
    participantId: string,
  ): Promise<void> {
    const changed = await this.updateState((state) => {
      const participant = state.participants[participantId];
      if (!participant || participant.socketId !== this.socketId(webSocket))
        return null;
      participant.socketId = null;
      participant.state = "LEFT";
      participant.mic = false;
      participant.cam = false;
      participant.screen = false;
      participant.typing = false;
      participant.handRaised = false;
      state.waiting = state.waiting.filter((id) => id !== participantId);
      for (const [hash, credential] of Object.entries(
        state.reconnectCredentials,
      )) {
        if (credential.participantId === participantId)
          delete state.reconnectCredentials[hash];
      }
      state.room.lastActivityAt = Date.now();
      return participant;
    });
    if (changed) {
      this.clearParticipantPresence(participantId);
      this.clearParticipantFileSubscriptions(participantId);
      await this.broadcast("participant_left", {
        participantId,
        reason: "left",
      });
    }
  }

  private async handleChat(
    actor: ParticipantRecord,
    data: ClientPayloads["chat_send"],
  ): Promise<void> {
    if (!hasCapability(actor, "chat")) {
      throw new RoomError("FORBIDDEN", "You cannot send messages in this room");
    }
    const message: ChatMessage = {
      id: `c_${randomToken(12)}`,
      participantId: actor.id,
      name: actor.name,
      body: data.body,
      at: Date.now(),
      clientMsgId: data.clientMsgId,
    };
    await this.updateState((state) => {
      state.chat.push(message);
      if (state.chat.length > MAX_CHAT_MESSAGES)
        state.chat.splice(0, state.chat.length - MAX_CHAT_MESSAGES);
    });
    await this.broadcast("chat_message", { message });
  }

  private async handleMediaState(
    actor: ParticipantRecord,
    data: ClientPayloads["media_state"],
  ): Promise<void> {
    const state = await this.readState();
    if (!state) throw new RoomError("ROOM_NOT_FOUND", "Room no longer exists");
    const canSpeak = hasCapability(actor, "speak");
    const canScreen = canScreenShare(actor, state.room.allowGuestScreenShare);
    const next = await this.updateParticipant(actor.id, {
      mic: data.mic && canSpeak,
      cam: data.cam,
      screen: data.screen && canScreen,
    });
    if (data.mic && !canSpeak) {
      this.sendToParticipant(actor.id, "error", {
        code: "FORBIDDEN",
        message: "The host has not granted you speak permission",
      });
    }
    if (data.screen && !canScreen) {
      this.sendToParticipant(actor.id, "error", {
        code: "FORBIDDEN",
        message: "Screen sharing is limited to the host and co-hosts",
      });
    }
    await this.broadcast("participant_updated", { participant: toWire(next) });
  }

  private async handlePresence(
    webSocket: WebSocket,
    actor: ParticipantRecord,
    message: Extract<
      ClientMessage,
      { type: "cursor_move" | "selection_change" | "viewport_change" }
    >,
  ): Promise<void> {
    if (!hasCapability(actor, "edit_code")) return;
    const fileId = message.data.fileId;
    const file = await this.findFile(fileId);
    if (!file || file.kind !== "file")
      throw new RoomError("CONFLICT", "File not found in this workspace");
    this.subscribeFile(actor.id, fileId);
    const update =
      message.type === "cursor_move"
        ? {
            kind: "cursor" as const,
            line: message.data.line,
            column: message.data.column,
            topLine: message.data.topLine,
          }
        : message.type === "selection_change"
          ? { kind: "selection" as const, ranges: message.data.ranges }
          : { kind: "viewport" as const, topLine: message.data.topLine };

    for (const socket of this.ctx.getWebSockets()) {
      const attachment = this.attachment(socket);
      if (attachment.participantId !== actor.id) continue;
      const presence = (attachment.presence ??= {});
      updatePresenceSnapshot(presence, actor.id, fileId, update);
      socket.serializeAttachment(attachment satisfies SocketAttachment);
    }

    // Exclude the sender by socket. Passing the participant id here never
    // matched, so every editor rendered its own caret under its own name.
    const exceptSocketId = this.socketId(webSocket);
    if (message.type === "cursor_move") {
      await this.broadcastFile(
        "cursor",
        {
          participantId: actor.id,
          fileId,
          line: message.data.line,
          column: message.data.column,
          topLine: message.data.topLine,
        },
        fileId,
        exceptSocketId,
      );
    } else if (message.type === "selection_change") {
      await this.broadcastFile(
        "selection",
        { participantId: actor.id, fileId, ranges: message.data.ranges },
        fileId,
        exceptSocketId,
      );
    } else {
      await this.broadcastFile(
        "viewport",
        { participantId: actor.id, fileId, topLine: message.data.topLine },
        fileId,
        exceptSocketId,
      );
    }
  }

  private async handleWebrtc(
    actor: ParticipantRecord,
    data: ClientPayloads["webrtc_signal"],
  ): Promise<void> {
    if (data.targetId === actor.id) return;
    const target = await this.readState()?.then(
      (state) => state?.participants[data.targetId],
    );
    if (!target || target.state !== "ADMITTED") {
      throw new RoomError("CONFLICT", "Peer is no longer in this room");
    }
    this.sendToParticipant(target.id, "webrtc_signal", {
      fromId: actor.id,
      signal: data.signal,
    });
  }

  private async handleYjsUpdate(
    webSocket: WebSocket,
    actor: ParticipantRecord,
    data: ClientPayloads["yjs_update"],
  ): Promise<void> {
    if (!hasCapability(actor, "edit_code")) {
      throw new RoomError("FORBIDDEN", "The host hasn't granted edit access");
    }
    const file = await this.findFile(data.fileId);
    if (!file || file.kind !== "file")
      throw new RoomError("CONFLICT", "File not found");
    const bytes = base64ToBytes(data.update);
    if (bytes.length === 0)
      throw new RoomError("INVALID_MESSAGE", "Empty update");
    if (bytes.length > 300_000)
      throw new RoomError("PAYLOAD_TOO_LARGE", "Update too large");
    await this.documentRequest(file.fileId, "POST", "/apply", {
      update: data.update,
    });
    this.subscribeFile(actor.id, file.fileId);
    const roomState = await this.readState();
    if (roomState?.room.workspaceMode === "local-fs") {
      const text = (await this.documentRequest(
        file.fileId,
        "GET",
        "/text",
      )) as {
        content: string;
      };
      void this.requestHost({
        op: "write",
        requesterId: actor.id,
        fileId: file.fileId,
        path: file.path,
        content: text.content,
      }).catch(() => undefined);
    }
    await this.broadcastFile(
      "yjs_sync",
      { fileId: file.fileId, update: data.update, kind: "diff" },
      file.fileId,
      this.socketId(webSocket),
    );
  }

  private async handleYjsSync(
    webSocket: WebSocket,
    actor: ParticipantRecord,
    data: ClientPayloads["yjs_sync_request"],
  ): Promise<void> {
    // Read-only participants may open a file and follow live edits. Writes
    // remain gated by handleYjsUpdate below.
    const file = await this.resolveFile(data.fileId, "");
    this.subscribeFile(actor.id, file.fileId);
    await this.replayFilePresence(webSocket, file.fileId);
    const result = (await this.documentRequest(
      file.fileId,
      "GET",
      "/diff",
      undefined,
      data.stateVector,
    )) as { update: string; kind: "snapshot" | "diff" };
    this.send(webSocket, "yjs_sync", {
      fileId: file.fileId,
      update: result.update,
      kind: data.stateVector ? "diff" : result.kind,
    });
  }

  private async handleFileOp(
    webSocket: WebSocket,
    actor: ParticipantRecord,
    data: ClientPayloads["file_op"],
  ): Promise<void> {
    const state = await this.readState();
    if (!state) throw new RoomError("ROOM_NOT_FOUND", "Room no longer exists");
    if (data.op === "open") {
      const file = await this.resolveFile(data.fileId, data.path);
      this.subscribeFile(actor.id, file.fileId);
      await this.replayFilePresence(webSocket, file.fileId);
      if (state.room.workspaceMode === "local-fs") {
        const response = await this.requestHost({
          op: "read",
          requesterId: actor.id,
          fileId: file.fileId,
          path: file.path,
        });
        if (!response.ok || typeof response.content !== "string") {
          throw new RoomError(
            "FS_TIMEOUT",
            response.error ?? "Could not read the file from the host",
          );
        }
        await this.documentRequest(file.fileId, "POST", "/seed", {
          content: response.content,
        });
        await this.updateFile(file.fileId, {
          size: response.content.length,
          mtime: response.mtime ?? Date.now(),
        });
      }
      const snapshot = (await this.documentRequest(
        file.fileId,
        "GET",
        "/snapshot",
      )) as { update: string };
      this.send(webSocket, "yjs_sync", {
        fileId: file.fileId,
        update: snapshot.update,
        kind: "snapshot",
      });
      return;
    }

    if (!hasCapability(actor, "file_write")) {
      throw new RoomError("FORBIDDEN", "The host hasn't granted edit access");
    }
    if (data.op === "create" || data.op === "mkdir") {
      if (state.files.length >= 600)
        throw new RoomError("CONFLICT", "Workspace file limit reached");
      const createConflict = workspacePathConflict(state.files, data.path, {
        allowImplicitDirectory: data.op === "mkdir",
      });
      if (createConflict) {
        throw new RoomError("CONFLICT", createConflict);
      }
      if (state.room.workspaceMode === "local-fs") {
        const response = await this.requestHost({
          op: data.op === "mkdir" ? "mkdir" : "create",
          requesterId: actor.id,
          path: data.path,
        });
        if (!response.ok)
          throw new RoomError(
            "CONFLICT",
            response.error ?? "The host could not create that entry",
          );
      }
      const meta: FileMeta = {
        fileId: `f_${randomToken(16)}`,
        path: data.path,
        kind: data.op === "mkdir" ? "dir" : "file",
        size: 0,
        mtime: Date.now(),
        lang: data.op === "mkdir" ? "plaintext" : languageFromPath(data.path),
      };
      await this.upsertFile(meta);
      await this.broadcast("file_changed", {
        op: data.op,
        path: meta.path,
        meta,
      });
      return;
    }

    const file = await this.resolveEntry(data.fileId, data.path);
    if (data.op === "rename" || data.op === "move") {
      const toPath = data.toPath?.trim();
      if (!toPath)
        throw new RoomError("INVALID_MESSAGE", "Missing destination path");
      if (toPath === file.path) return;
      const moveConflict = workspaceMoveConflict(
        state.files,
        file.path,
        toPath,
        file.kind,
      );
      if (moveConflict) throw new RoomError("CONFLICT", moveConflict);
      if (state.room.workspaceMode === "local-fs") {
        const response = await this.requestHost({
          op: "rename",
          requesterId: actor.id,
          fileId: file.fileId,
          path: file.path,
          toPath,
        });
        if (!response.ok)
          throw new RoomError(
            "CONFLICT",
            response.error ?? "The host could not rename that entry",
          );
      }
      await this.updateState((current) => {
        for (const entry of current.files) {
          const movedPath = moveWorkspacePath(entry.path, file.path, toPath);
          if (movedPath !== entry.path) {
            entry.path = movedPath;
            entry.lang =
              entry.kind === "file"
                ? languageFromPath(entry.path)
                : "plaintext";
            entry.mtime = Date.now();
          }
        }
      });
      await this.broadcast("file_changed", {
        op: data.op,
        path: file.path,
        toPath,
        meta: {
          ...file,
          path: toPath,
          lang: file.kind === "file" ? languageFromPath(toPath) : "plaintext",
          mtime: Date.now(),
        },
      });
      return;
    }

    if (data.op === "delete") {
      if (state.room.workspaceMode === "local-fs") {
        const response = await this.requestHost({
          op: "delete",
          requesterId: actor.id,
          fileId: file.fileId,
          path: file.path,
        });
        if (!response.ok)
          throw new RoomError(
            "CONFLICT",
            response.error ?? "The host could not delete that entry",
          );
      }
      const deletedFiles = (await this.listFiles()).filter(
        (entry) =>
          entry.path === file.path ||
          (file.kind === "dir" && entry.path.startsWith(`${file.path}/`)),
      );
      await this.updateState((current) => {
        current.files = current.files.filter(
          (entry) =>
            !(
              entry.path === file.path ||
              (file.kind === "dir" && entry.path.startsWith(`${file.path}/`))
            ),
        );
        for (const entry of deletedFiles) {
          if (entry.kind === "file") this.clearFilePresence(entry.fileId);
        }
      });
      await Promise.allSettled(
        deletedFiles
          .filter((entry) => entry.kind === "file")
          .map((entry) =>
            this.documentRequest(entry.fileId, "DELETE", "/delete"),
          ),
      );
      await this.broadcast("file_changed", { op: "delete", path: file.path });
    }
  }

  private async handleBridgeAttach(
    actor: ParticipantRecord,
    data: ClientPayloads["fs_bridge_attach"],
  ): Promise<void> {
    const state = await this.readState();
    if (!state) throw new RoomError("ROOM_NOT_FOUND", "Room no longer exists");
    if (state.room.hostParticipantId !== actor.id) {
      throw new RoomError(
        "FORBIDDEN",
        "Only the host can connect a local folder",
      );
    }
    if (!data.connected) {
      this.clearAllFileSubscriptions();
      this.clearAllPresence();
      const previous = await this.listFiles();
      await this.updateState((current) => {
        current.files = [];
        current.room.workspaceMode = "virtual";
        current.room.rootName = null;
      });
      await Promise.allSettled(
        previous
          .filter((entry) => entry.kind === "file")
          .map((entry) =>
            this.documentRequest(entry.fileId, "DELETE", "/delete"),
          ),
      );
      await this.broadcast("workspace_reset", {
        files: [],
        rootName: null,
        mode: "virtual",
      });
      return;
    }
    // File ids and document contents are workspace-scoped. Invalidate every
    // subscription before replacing the workspace so stale viewers cannot
    // receive updates from the previous or newly attached folder.
    this.clearAllFileSubscriptions();
    this.clearAllPresence();
    const previous = await this.listFiles();
    const byPath = new Map(previous.map((entry) => [entry.path, entry]));
    const files = data.snapshot.slice(0, 600).map((entry) => ({
      fileId: byPath.get(entry.path)?.fileId ?? `f_${randomToken(16)}`,
      path: entry.path,
      kind: entry.kind,
      size: entry.size,
      mtime: entry.mtime,
      lang: entry.kind === "file" ? languageFromPath(entry.path) : "plaintext",
    }));
    await this.updateState((current) => {
      current.files = files;
      current.room.workspaceMode = "local-fs";
      current.room.rootName = data.rootName.slice(0, 120) || "Local folder";
    });
    await Promise.allSettled(
      previous
        .filter((entry) => entry.kind === "file")
        .map((entry) =>
          this.documentRequest(entry.fileId, "DELETE", "/delete"),
        ),
    );
    await this.broadcast("workspace_reset", {
      files,
      rootName: data.rootName,
      mode: "local-fs",
    });
  }

  private async handleFsResponse(
    actor: ParticipantRecord,
    kind: "fs_file_content" | "fs_ack",
    data: ClientPayloads["fs_file_content"] | ClientPayloads["fs_ack"],
  ): Promise<void> {
    const state = await this.readState();
    if (!state || state.room.hostParticipantId !== actor.id) {
      throw new RoomError(
        "FORBIDDEN",
        "Only the host may answer filesystem requests",
      );
    }
    const pending = state.pendingFs[data.requestId];
    if (!pending) return;
    let response: FsResponse;
    if (kind === "fs_file_content") {
      const content = data as ClientPayloads["fs_file_content"];
      response = {
        ok: true,
        content: content.content,
        fileId: content.fileId,
        mtime: content.mtime,
      };
    } else {
      const ack = data as ClientPayloads["fs_ack"];
      response = {
        ok: ack.ok,
        error: ack.error,
        fileId: ack.fileId,
        path: ack.path,
      };
    }
    await this.updateState((current) => {
      delete current.pendingFs[data.requestId];
      if (
        kind === "fs_file_content" &&
        current.room.hostParticipantId === actor.id
      ) {
        const file = current.files.find(
          (entry) =>
            entry.fileId === (data as ClientPayloads["fs_file_content"]).fileId,
        );
        if (file) {
          file.size = (
            data as ClientPayloads["fs_file_content"]
          ).content.length;
          file.mtime = (data as ClientPayloads["fs_file_content"]).mtime;
        }
      }
      if (kind === "fs_ack" && (data as ClientPayloads["fs_ack"]).ok) {
        const fileId = (data as ClientPayloads["fs_ack"]).fileId;
        if (fileId) {
          const file = current.files.find((entry) => entry.fileId === fileId);
          if (file) file.mtime = Date.now();
        }
      }
    });
    const resolver = this.pendingResponses.get(data.requestId);
    if (resolver) {
      clearTimeout(resolver.timer);
      this.pendingResponses.delete(data.requestId);
      resolver.resolve(response);
    }
  }

  private async requestHost(
    request: Omit<PendingFsRequest, "requestId" | "createdAt">,
  ): Promise<FsResponse> {
    const state = await this.readState();
    if (!state) throw new RoomError("ROOM_NOT_FOUND", "Room no longer exists");
    const host = state.participants[state.room.hostParticipantId];
    if (!host?.socketId) {
      throw new RoomError(
        "FS_NOT_CONNECTED",
        "The host is offline or has not connected a folder",
      );
    }
    const requestId = `fs_${randomToken(12)}`;
    await this.updateState((current) => {
      current.pendingFs[requestId] = {
        ...request,
        requestId,
        createdAt: Date.now(),
      };
    });
    const promise = new Promise<FsResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingResponses.delete(requestId);
        void this.updateState((current) => {
          delete current.pendingFs[requestId];
        }).catch(() => undefined);
        resolve({ ok: false, error: "The host did not respond in time" });
      }, FS_TIMEOUT_MS);
      this.pendingResponses.set(requestId, { resolve, timer });
    });
    this.sendToParticipant(host.id, "fs_request", {
      requestId,
      op: request.op,
      fileId: request.fileId,
      path: request.path,
      toPath: request.toPath,
      content: request.content,
    });
    return promise;
  }

  private async handleHostAction(
    actor: ParticipantRecord,
    data: ClientPayloads["host_action"],
  ): Promise<void> {
    const state = await this.readState();
    if (!state) throw new RoomError("ROOM_NOT_FOUND", "Room no longer exists");
    const target = data.targetId
      ? state.participants[data.targetId]
      : undefined;
    const requireTarget = (): ParticipantRecord => {
      if (!target)
        throw new RoomError("INVALID_MESSAGE", "Target participant not found");
      return target;
    };
    const requireCapability = (
      capability: Parameters<typeof hasCapability>[1],
    ): void => {
      if (!hasCapability(actor, capability)) {
        throw new RoomError(
          "FORBIDDEN",
          `You are not allowed to ${data.action.replaceAll("_", " ")}`,
        );
      }
    };

    switch (data.action) {
      case "admit": {
        requireCapability("admit");
        const waiting = requireTarget();
        if (waiting.state !== "WAITING")
          throw new RoomError("CONFLICT", "Participant is not waiting");
        const role = this.assignedRole(data.payload?.role);
        if (role !== "VIEWER" && !canAssignRole(actor, role)) {
          throw new RoomError("FORBIDDEN", "You cannot assign that role");
        }
        await this.admitParticipant(waiting.id, role);
        break;
      }
      case "admit_all": {
        requireCapability("admit");
        for (const id of [...state.waiting])
          await this.admitParticipant(id, "VIEWER");
        break;
      }
      case "deny": {
        requireCapability("admit");
        const waiting = requireTarget();
        if (waiting.state !== "WAITING")
          throw new RoomError("CONFLICT", "Participant is not waiting");
        await this.updateState((current) => {
          const participant = current.participants[waiting.id];
          participant.state = "DENIED";
          participant.socketId = null;
          current.waiting = current.waiting.filter((id) => id !== waiting.id);
          for (const [hash, credential] of Object.entries(
            current.reconnectCredentials,
          )) {
            if (credential.participantId === waiting.id)
              delete current.reconnectCredentials[hash];
          }
        });
        this.sendToParticipant(waiting.id, "denied", {
          reason: "The host denied your request to join",
        });
        this.closeParticipantSocket(
          waiting.id,
          WS_CLOSE.FORBIDDEN,
          "Denied by host",
        );
        await this.broadcast("waiting_room", {
          waiting: await this.waitingParticipants(),
        });
        break;
      }
      case "kick": {
        const victim = requireTarget();
        if (!canKick(actor, victim))
          throw new RoomError(
            "FORBIDDEN",
            "You cannot remove this participant",
          );
        await this.updateState((current) => {
          const participant = current.participants[victim.id];
          participant.state = "REMOVED";
          participant.socketId = null;
          participant.typing = false;
          participant.mic = false;
          participant.cam = false;
          participant.screen = false;
          participant.handRaised = false;
          for (const [hash, credential] of Object.entries(
            current.reconnectCredentials,
          )) {
            if (credential.participantId === victim.id)
              delete current.reconnectCredentials[hash];
          }
        });
        this.sendToParticipant(victim.id, "kicked", {
          reason: "Removed by host",
        });
        this.closeParticipantSocket(
          victim.id,
          WS_CLOSE.FORBIDDEN,
          "Removed by host",
        );
        this.clearParticipantPresence(victim.id);
        this.clearParticipantFileSubscriptions(victim.id);
        await this.broadcast("participant_left", {
          participantId: victim.id,
          reason: "kicked",
        });
        break;
      }
      case "lock_room":
      case "unlock_room": {
        requireCapability("lock_room");
        const locked = data.action === "lock_room";
        await this.updateState((current) => {
          current.room.status = locked ? "locked" : "open";
        });
        await this.broadcast("host_action", {
          action: data.action,
          actorId: actor.id,
          payload: { locked },
        });
        break;
      }
      case "set_role": {
        const victim = requireTarget();
        const role = this.assignedRole(data.payload?.role);
        if (!canManageParticipant(actor, victim))
          throw new RoomError(
            "FORBIDDEN",
            "You cannot change this participant",
          );
        if (!canAssignRole(actor, role))
          throw new RoomError("FORBIDDEN", "Role change not permitted");
        await this.persistGrant(
          victim.id,
          { role, ...defaultsForRole(role) },
          `role:${role}`,
        );
        break;
      }
      case "grant_edit":
      case "revoke_edit": {
        const victim = requireTarget();
        if (!canManageParticipant(actor, victim))
          throw new RoomError("FORBIDDEN", "Not allowed");
        const canEdit = data.action === "grant_edit";
        await this.persistGrant(
          victim.id,
          { canEdit },
          canEdit ? "granted_edit" : "revoked_edit",
        );
        break;
      }
      case "grant_speak":
      case "revoke_speak": {
        const victim = requireTarget();
        if (!canManageParticipant(actor, victim))
          throw new RoomError("FORBIDDEN", "Not allowed");
        const canSpeak = data.action === "grant_speak";
        await this.persistGrant(
          victim.id,
          canSpeak ? { canSpeak, handRaised: false } : { canSpeak, mic: false },
          canSpeak ? "granted_speak" : "revoked_speak",
        );
        if (!canSpeak) {
          this.sendToParticipant(victim.id, "host_action", {
            action: "mute",
            actorId: actor.id,
            targetId: victim.id,
            payload: { reason: "speak_revoked" },
          });
        }
        break;
      }
      case "mute": {
        requireCapability("manage_media");
        const victim = requireTarget();
        if (!canManageParticipant(actor, victim))
          throw new RoomError("FORBIDDEN", "Not allowed");
        const muted = await this.updateParticipant(victim.id, { mic: false });
        await this.broadcast("participant_updated", {
          participant: toWire(muted),
        });
        this.sendToParticipant(victim.id, "host_action", {
          action: "mute",
          actorId: actor.id,
          targetId: victim.id,
        });
        break;
      }
      case "ask_unmute": {
        requireCapability("manage_media");
        const victim = requireTarget();
        if (!victim.canSpeak)
          throw new RoomError(
            "CONFLICT",
            "Participant has no speak permission",
          );
        this.sendToParticipant(victim.id, "host_action", {
          action: "ask_unmute",
          actorId: actor.id,
          targetId: victim.id,
        });
        break;
      }
      case "transfer_host": {
        if (!canTransferHost(actor))
          throw new RoomError("FORBIDDEN", "Only the host can transfer host");
        const victim = requireTarget();
        if (victim.id === actor.id || victim.state !== "ADMITTED") {
          throw new RoomError("CONFLICT", "Pick an admitted participant");
        }
        const replacementToken = randomToken();
        const replacementHash = await sha256Hex(replacementToken);
        const transferred = await this.updateState((current) => {
          if (current.room.hostParticipantId !== actor.id) return false;
          const oldHost = current.participants[actor.id];
          const newHost = current.participants[victim.id];
          if (!oldHost || !newHost || newHost.state !== "ADMITTED")
            return false;
          oldHost.role = "CO_HOST";
          oldHost.canEdit = true;
          oldHost.canSpeak = true;
          newHost.role = "HOST";
          newHost.canEdit = true;
          newHost.canSpeak = true;
          current.room.hostParticipantId = newHost.id;
          current.hostCredential = {
            participantId: newHost.id,
            tokenHash: replacementHash,
          };
          return true;
        });
        if (!transferred)
          throw new RoomError("CONFLICT", "Host ownership changed; try again");
        for (const participantId of [actor.id, victim.id]) {
          await this.broadcast("permission_changed", {
            participantId,
            role: participantId === actor.id ? "CO_HOST" : "HOST",
            canEdit: true,
            canSpeak: true,
            reason: "host_transfer",
          });
          await this.broadcast("participant_updated", {
            participant: await this.wireParticipant(participantId),
          });
        }
        await this.broadcast("host_action", {
          action: "transfer_host",
          actorId: actor.id,
          targetId: victim.id,
          payload: { hostParticipantId: victim.id },
        });
        this.sendToParticipant(victim.id, "host_action", {
          action: "transfer_host",
          actorId: actor.id,
          targetId: victim.id,
          payload: {
            hostParticipantId: victim.id,
            hostToken: replacementToken,
          },
        });
        break;
      }
      case "end_session": {
        if (!canEndSession(actor))
          throw new RoomError("FORBIDDEN", "Only the host can end the session");
        await this.updateState((current) => {
          current.room.status = "ended";
          current.room.lastActivityAt = Date.now();
        });
        await this.broadcast("room_ended", { reason: "host_ended" });
        for (const webSocket of this.ctx.getWebSockets()) {
          webSocket.close(WS_CLOSE.ROOM_ENDED, "Session ended");
        }
        break;
      }
      case "toggle_admit_mode": {
        requireCapability("admit");
        const admitMode = await this.updateState((current) => {
          const next = current.room.admitMode === "auto" ? "manual" : "auto";
          current.room.admitMode = next;
          return next;
        });
        await this.broadcast("host_action", {
          action: data.action,
          actorId: actor.id,
          payload: { admitMode },
        });
        break;
      }
      case "toggle_screen_share": {
        requireCapability("manage_media");
        const allowGuestScreenShare = await this.updateState((current) => {
          const next = !current.room.allowGuestScreenShare;
          current.room.allowGuestScreenShare = next;
          return next;
        });
        await this.broadcast("host_action", {
          action: data.action,
          actorId: actor.id,
          payload: { allowGuestScreenShare },
        });
        break;
      }
      case "save_workspace": {
        if (state.room.hostParticipantId !== actor.id) {
          throw new RoomError("FORBIDDEN", "Only the host can save to disk");
        }
        await this.saveWorkspace(actor, data.payload?.operationId);
        break;
      }
      default:
        throw new RoomError("INVALID_MESSAGE", "Unknown host action");
    }
  }

  private async admitParticipant(
    participantId: string,
    role: Role,
  ): Promise<void> {
    const reconnectToken = randomToken();
    const hash = await sha256Hex(reconnectToken);
    const result = await this.updateState((state) => {
      const participant = state.participants[participantId];
      if (!participant || participant.state !== "WAITING") return null;
      const admittedCount = Object.values(state.participants).filter(
        (entry) => entry.state === "ADMITTED" && entry.socketId,
      ).length;
      if (admittedCount >= state.room.maxParticipants) return null;
      const grants = defaultsForRole(role);
      participant.role = role;
      participant.state = "ADMITTED";
      participant.canEdit = grants.canEdit;
      participant.canSpeak = grants.canSpeak;
      participant.mic = false;
      participant.cam = false;
      participant.screen = false;
      participant.typing = false;
      state.waiting = state.waiting.filter((id) => id !== participantId);
      this.rememberReconnectToken(state, hash, participantId, Date.now());
      return participant;
    });
    if (!result)
      throw new RoomError("PARTICIPANT_LIMIT", "This session is full");
    this.sendToParticipant(
      participantId,
      "room_state",
      await this.roomState(participantId),
    );
    this.sendToParticipant(participantId, "admitted", {
      reconnectToken,
      self: toWire(result),
    });
    await this.broadcast("participant_joined", { participant: toWire(result) });
    await this.broadcast("waiting_room", {
      waiting: await this.waitingParticipants(),
    });
  }

  private async persistGrant(
    participantId: string,
    patch: Partial<ParticipantRecord>,
    reason: string,
  ): Promise<void> {
    const next = await this.updateParticipant(participantId, patch);
    // Losing edit access removes the live cursor, but not an already-open
    // file: read-only participants keep following its content.
    if (!hasCapability(next, "edit_code")) {
      this.clearParticipantPresence(participantId);
    }
    await this.broadcast("permission_changed", {
      participantId,
      role: next.role,
      canEdit: next.canEdit,
      canSpeak: next.canSpeak,
      reason,
    });
    await this.broadcast("participant_updated", { participant: toWire(next) });
  }

  private async saveWorkspace(
    actor: ParticipantRecord,
    rawOperationId?: unknown,
  ): Promise<void> {
    const operationId =
      typeof rawOperationId === "string"
        ? rawOperationId.slice(0, 64)
        : `save_${Date.now()}`;
    const state = await this.readState();
    if (!state) throw new RoomError("ROOM_NOT_FOUND", "Room no longer exists");
    this.sendToParticipant(actor.id, "workspace_save", {
      operationId,
      phase: "saving",
      mode: state.room.workspaceMode,
      total: 0,
      saved: 0,
      failed: 0,
      failures: [],
    });
    if (state.room.workspaceMode !== "local-fs") {
      this.sendToParticipant(actor.id, "workspace_save", {
        operationId,
        phase: "success",
        mode: state.room.workspaceMode,
        total: 0,
        saved: 0,
        failed: 0,
        failures: [],
      });
      return;
    }
    const files = (await this.listFiles()).filter(
      (entry) => entry.kind === "file",
    );
    if (files.length === 0) {
      this.sendToParticipant(actor.id, "workspace_save", {
        operationId,
        phase: "empty",
        mode: state.room.workspaceMode,
        total: 0,
        saved: 0,
        failed: 0,
        failures: [],
      });
      return;
    }
    let saved = 0;
    const failures: Array<{ path: string; error: string }> = [];
    for (const file of files.filter((entry) => entry.kind === "file")) {
      try {
        const text = (await this.documentRequest(
          file.fileId,
          "GET",
          "/text",
        )) as { content: string };
        const response = await this.requestHost({
          op: "write",
          requesterId: actor.id,
          fileId: file.fileId,
          path: file.path,
          content: text.content,
        });
        if (!response.ok)
          failures.push({
            path: file.path,
            error: response.error ?? "Write failed",
          });
        else saved += 1;
      } catch (error) {
        failures.push({
          path: file.path,
          error: error instanceof Error ? error.message : "Write failed",
        });
      }
    }
    this.sendToParticipant(actor.id, "workspace_save", {
      operationId,
      phase: failures.length === 0 ? "success" : "partial",
      mode: state.room.workspaceMode,
      total: files.length,
      saved,
      failed: failures.length,
      failures,
    });
  }

  private async sendPermissionRequests(
    actor: ParticipantRecord,
    kind: "edit" | "speak",
    note?: string,
  ): Promise<void> {
    const state = await this.readState();
    if (!state) return;
    for (const participant of Object.values(state.participants)) {
      if (participant.id === actor.id || participant.state !== "ADMITTED")
        continue;
      if (!hasCapability(participant, "manage_roles")) continue;
      this.sendToParticipant(participant.id, "permission_request", {
        participantId: actor.id,
        name: actor.name,
        kind,
        note,
      });
    }
  }

  private async roomState(
    selfId: string,
  ): Promise<ServerPayloads["room_state"]> {
    const state = await this.readState();
    if (!state) throw new RoomError("ROOM_NOT_FOUND", "Room no longer exists");
    const self = state.participants[selfId];
    if (!self)
      throw new RoomError("NOT_ADMITTED", "You are not admitted to this room");
    const participants = Object.values(state.participants)
      .filter(
        (participant) =>
          participant.state === "ADMITTED" &&
          // A closed socket is not present in the room, even while its
          // reconnect window is still open. Showing it produced duplicate
          // people (notably a stale HOST) after a reload.
          (participant.socketId !== null || participant.id === selfId),
      )
      .sort((a, b) => roleOrder(a.role) - roleOrder(b.role))
      .map(toWire);
    const waiting = Object.values(state.participants)
      .filter((participant) => participant.state === "WAITING")
      .map(toWire);
    return {
      room: {
        id: state.room.id,
        key: state.room.key,
        title: state.room.title,
        status: state.room.status,
        admitMode: state.room.admitMode,
        hostParticipantId: state.room.hostParticipantId,
        allowGuestScreenShare: state.room.allowGuestScreenShare,
        maxParticipants: state.room.maxParticipants,
        workspaceMode: state.room.workspaceMode,
        rootName: state.room.rootName,
        createdAt: state.room.createdAt,
      },
      self: toWire(self),
      participants,
      files: state.files,
      chat: state.chat,
      waiting,
      serverTime: Date.now(),
    };
  }

  private async waitingParticipants(): Promise<Participant[]> {
    const state = await this.readState();
    if (!state) return [];
    return state.waiting
      .map((id) => state.participants[id])
      .filter((participant): participant is ParticipantRecord =>
        Boolean(participant),
      )
      .map(toWire);
  }

  private async wireParticipant(participantId: string): Promise<Participant> {
    const participant = (await this.readState())?.participants[participantId];
    if (!participant)
      throw new RoomError("CONFLICT", "Participant no longer exists");
    return toWire(participant);
  }

  private async updateParticipant(
    participantId: string,
    patch: Partial<ParticipantRecord>,
  ): Promise<ParticipantRecord> {
    const participant = await this.updateState((state) => {
      const current = state.participants[participantId];
      if (!current) return null;
      Object.assign(current, patch);
      current.lastSeenAt = Date.now();
      return current;
    });
    if (!participant)
      throw new RoomError("CONFLICT", "Participant no longer exists");
    return participant;
  }

  private async updateState<T>(
    mutator: (state: DurableRoomState) => T,
  ): Promise<T> {
    return this.ctx.storage.transaction(async (txn) => {
      const state = await txn.get<DurableRoomState>(STATE_KEY);
      if (!state)
        throw new RoomError("ROOM_NOT_FOUND", "Room no longer exists");
      const result = mutator(state);
      await txn.put(STATE_KEY, state);
      return result;
    });
  }

  private async readState(): Promise<DurableRoomState | null> {
    return (await this.ctx.storage.get<DurableRoomState>(STATE_KEY)) ?? null;
  }

  private async listFiles(): Promise<FileMeta[]> {
    return (await this.readState())?.files ?? [];
  }

  private async findFile(fileId: string): Promise<FileMeta | undefined> {
    return (await this.listFiles()).find((file) => file.fileId === fileId);
  }

  private async findFileByPath(path: string): Promise<FileMeta | undefined> {
    return (await this.listFiles()).find((file) => file.path === path);
  }

  private async resolveEntry(
    fileId: string | undefined,
    path: string,
  ): Promise<FileMeta> {
    const file = fileId
      ? await this.findFile(fileId)
      : await this.findFileByPath(path);
    if (!file)
      throw new RoomError("CONFLICT", "File not found in this workspace");
    return file;
  }

  private async resolveFile(
    fileId: string | undefined,
    path: string,
  ): Promise<FileMeta> {
    const file = await this.resolveEntry(fileId, path);
    if (file.kind !== "file")
      throw new RoomError("CONFLICT", "File not found in this workspace");
    return file;
  }

  private async upsertFile(file: FileMeta): Promise<void> {
    await this.updateState((state) => {
      const index = state.files.findIndex(
        (entry) => entry.fileId === file.fileId,
      );
      if (index >= 0) state.files[index] = file;
      else state.files.push(file);
    });
  }

  private async updateFile(
    fileId: string,
    patch: Partial<FileMeta>,
  ): Promise<void> {
    await this.updateState((state) => {
      const file = state.files.find((entry) => entry.fileId === fileId);
      if (file) Object.assign(file, patch);
    });
  }

  private async documentRequest(
    fileId: string,
    method: "GET" | "POST" | "DELETE",
    pathname: string,
    body?: unknown,
    query?: string,
  ): Promise<unknown> {
    const state = await this.readState();
    if (!state) throw new RoomError("ROOM_NOT_FOUND", "Room no longer exists");
    const id = this.env.DOCUMENT_DO.idFromName(`${state.room.id}:${fileId}`);
    const stub = this.env.DOCUMENT_DO.get(id);
    const url = new URL(
      `https://document.internal${pathname}${query ? `?${query}` : ""}`,
    );
    const response = await stub.fetch(url.toString(), {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const result = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      throw new RoomError(
        "INTERNAL",
        typeof result.error === "string"
          ? result.error
          : "Document unavailable",
      );
    }
    return result;
  }

  private async replayFilePresence(
    webSocket: WebSocket,
    fileId: string,
  ): Promise<void> {
    const state = await this.readState();
    const attachment = this.attachment(webSocket);
    if (!state || !attachment.participantId) return;
    const viewer = state.participants[attachment.participantId];
    if (!viewer || viewer.state !== "ADMITTED") return;
    const now = Date.now();
    for (const peerSocket of this.ctx.getWebSockets()) {
      const peer = this.attachment(peerSocket);
      if (
        !peer.participantId ||
        peer.participantId === attachment.participantId
      )
        continue;
      const participant = state.participants[peer.participantId];
      if (
        !participant ||
        participant.state !== "ADMITTED" ||
        !hasCapability(participant, "edit_code")
      ) {
        continue;
      }
      if (!peer.presence) continue;
      const before = JSON.stringify(peer.presence);
      prunePresenceSnapshots(peer.presence, now);
      if (JSON.stringify(peer.presence) !== before) {
        peerSocket.serializeAttachment(peer satisfies SocketAttachment);
      }
      const snapshot = peer.presence[fileId]?.[peer.participantId];
      if (!snapshot) continue;
      if (snapshot.cursor) {
        this.send(webSocket, "cursor", {
          participantId: participant.id,
          fileId,
          line: snapshot.cursor.line,
          column: snapshot.cursor.column,
          topLine: snapshot.cursor.topLine,
        });
      }
      if (snapshot.selection) {
        this.send(webSocket, "selection", {
          participantId: participant.id,
          fileId,
          ranges: snapshot.selection,
        });
      }
      if (snapshot.viewport !== undefined) {
        this.send(webSocket, "viewport", {
          participantId: participant.id,
          fileId,
          topLine: snapshot.viewport,
        });
      }
    }
  }

  private clearParticipantPresence(participantId: string): void {
    for (const webSocket of this.ctx.getWebSockets()) {
      const attachment = this.attachment(webSocket);
      if (!attachment.presence) continue;
      clearParticipantPresence(attachment.presence, participantId);
      webSocket.serializeAttachment(attachment satisfies SocketAttachment);
    }
  }

  private clearFilePresence(fileId: string): void {
    for (const webSocket of this.ctx.getWebSockets()) {
      const attachment = this.attachment(webSocket);
      if (attachment.presence) clearFilePresence(attachment.presence, fileId);
      removeFileSubscription(attachment.files, fileId);
      webSocket.serializeAttachment(attachment satisfies SocketAttachment);
    }
  }

  private clearAllPresence(): void {
    for (const webSocket of this.ctx.getWebSockets()) {
      const attachment = this.attachment(webSocket);
      if (!attachment.presence) continue;
      clearAllPresence(attachment.presence);
      webSocket.serializeAttachment(attachment satisfies SocketAttachment);
    }
  }

  private subscribeFile(participantId: string, fileId: string): void {
    for (const webSocket of this.ctx.getWebSockets()) {
      const attachment = this.attachment(webSocket);
      if (attachment.participantId !== participantId) continue;
      addFileSubscription(attachment.files, fileId);
      webSocket.serializeAttachment(attachment satisfies SocketAttachment);
    }
  }

  private async broadcast<T extends keyof ServerPayloads>(
    type: T,
    data: ServerPayloads[T],
    exceptSocketId?: string,
  ): Promise<void> {
    const state = await this.readState();
    if (!state) return;

    for (const webSocket of this.ctx.getWebSockets()) {
      if (exceptSocketId && this.socketId(webSocket) === exceptSocketId)
        continue;

      const attachment = this.attachment(webSocket);
      if (!attachment.participantId) continue;

      const participant = state.participants[attachment.participantId];
      if (!participant || participant.state !== "ADMITTED") continue;

      this.send(webSocket, type, data);
    }
  }

  private async broadcastFile<T extends keyof ServerPayloads>(
    type: T,
    data: ServerPayloads[T],
    fileId: string,
    exceptSocketId?: string,
  ): Promise<void> {
    for (const webSocket of this.ctx.getWebSockets()) {
      if (exceptSocketId && this.socketId(webSocket) === exceptSocketId)
        continue;
      const attachment = this.attachment(webSocket);
      // Subscriptions are granted only after an admitted participant opens the
      // file. They carry live edits and presence to readers too, not just to
      // participants with edit capability.
      if (!attachment.files.includes(fileId)) continue;
      this.send(webSocket, type, data);
    }
  }

  private clearParticipantFileSubscriptions(participantId: string): void {
    for (const webSocket of this.ctx.getWebSockets()) {
      const attachment = this.attachment(webSocket);
      if (attachment.participantId !== participantId) continue;
      clearFileSubscriptions(attachment.files);
      webSocket.serializeAttachment(attachment satisfies SocketAttachment);
    }
  }

  private clearAllFileSubscriptions(): void {
    for (const webSocket of this.ctx.getWebSockets()) {
      const attachment = this.attachment(webSocket);
      clearFileSubscriptions(attachment.files);
      webSocket.serializeAttachment(attachment satisfies SocketAttachment);
    }
  }

  private sendToParticipant<T extends keyof ServerPayloads>(
    participantId: string,
    type: T,
    data: ServerPayloads[T],
  ): void {
    for (const webSocket of this.ctx.getWebSockets()) {
      if (this.attachment(webSocket).participantId === participantId)
        this.send(webSocket, type, data);
    }
  }

  private closeParticipantSocket(
    participantId: string,
    code: number,
    reason: string,
  ): void {
    for (const webSocket of this.ctx.getWebSockets()) {
      if (this.attachment(webSocket).participantId === participantId)
        webSocket.close(code, reason);
    }
  }

  private send<T extends keyof ServerPayloads>(
    webSocket: WebSocket,
    type: T,
    data: ServerPayloads[T],
  ): void {
    try {
      webSocket.send(
        JSON.stringify({
          v: PROTOCOL_VERSION,
          id: randomToken(8),
          type,
          ts: Date.now(),
          data,
        }),
      );
    } catch {
      try {
        webSocket.close(WS_CLOSE.REPLACED, "Connection is no longer available");
      } catch {
        // The socket may already be closed by the runtime.
      }
    }
  }

  private sendError(
    webSocket: WebSocket,
    code: ServerPayloads["error"]["code"],
    message: string,
    requestId?: string,
  ): void {
    this.send(webSocket, "error", { code, message, requestId });
  }

  private attachment(webSocket: WebSocket): SocketAttachment {
    const value =
      webSocket.deserializeAttachment() as Partial<SocketAttachment> | null;
    return {
      socketId: value?.socketId ?? "unknown",
      participantId: value?.participantId,
      files: Array.isArray(value?.files) ? value.files : [],
      presence: value?.presence ?? {},
      messageCount: value?.messageCount ?? 0,
      rateStartedAt: value?.rateStartedAt ?? Date.now(),
    };
  }

  private socketId(webSocket: WebSocket): string {
    return this.attachment(webSocket).socketId;
  }

  private allowMessage(
    webSocket: WebSocket,
    attachment: SocketAttachment,
  ): boolean {
    const now = Date.now();
    if (now - attachment.rateStartedAt > 1_000) {
      attachment.rateStartedAt = now;
      attachment.messageCount = 0;
    }
    attachment.messageCount += 1;
    webSocket.serializeAttachment(attachment satisfies SocketAttachment);
    return attachment.messageCount <= MESSAGE_RATE_LIMIT;
  }

  private evictSocket(
    previousSocketId: string | null,
    currentSocketId: string,
  ): void {
    if (!previousSocketId || previousSocketId === currentSocketId) return;
    for (const webSocket of this.ctx.getWebSockets()) {
      if (this.socketId(webSocket) !== previousSocketId) continue;
      this.sendError(
        webSocket,
        "CONFLICT",
        "This session was resumed in another tab or device.",
      );
      webSocket.close(WS_CLOSE.REPLACED, "Session resumed elsewhere");
    }
  }

  /**
   * Record a fresh reconnect token without discarding the participant's
   * previous ones. Tokens keep working until their expiry so a tab that loses
   * the `admitted` frame mid-reconnect can retry with the token it still has.
   * The newest few are kept and the rest age out with the 15 minute TTL.
   */
  private rememberReconnectToken(
    state: DurableRoomState,
    tokenHash: string,
    participantId: string,
    now: number,
  ): void {
    for (const [hash, credential] of Object.entries(
      state.reconnectCredentials,
    )) {
      if (credential.expiresAt < now) delete state.reconnectCredentials[hash];
    }
    state.reconnectCredentials[tokenHash] = {
      participantId,
      expiresAt: now + 15 * 60_000,
    };
    const own = Object.entries(state.reconnectCredentials)
      .filter(([, credential]) => credential.participantId === participantId)
      .sort((a, b) => b[1].expiresAt - a[1].expiresAt);
    for (const [hash] of own.slice(5)) delete state.reconnectCredentials[hash];
  }

  private assignedRole(value: unknown): Role {
    return value === "CO_HOST" || value === "EDITOR" || value === "VIEWER"
      ? value
      : "VIEWER";
  }

  private uniqueName(requested: string, used: string[]): string {
    const base = requested.trim().slice(0, 48) || "Guest";
    if (!used.includes(base.toLocaleLowerCase())) return base;
    for (let index = 2; index < 1000; index += 1) {
      const suffix = ` (${index})`;
      const candidate = `${base.slice(0, 48 - suffix.length).trimEnd()}${suffix}`;
      if (!used.includes(candidate.toLocaleLowerCase())) return candidate;
    }
    return `${base.slice(0, 40)} ${Date.now().toString(36)}`;
  }

  private pickColor(seed: number): string {
    const colors = [
      "#4ea1ff",
      "#f2a33c",
      "#7ee787",
      "#ff7b9c",
      "#c792ea",
      "#5ad4c8",
    ];
    return colors[seed % colors.length] ?? colors[0];
  }

  private maxParticipants(): number {
    const parsed = Number(this.env.MAX_PARTICIPANTS);
    return Number.isSafeInteger(parsed) && parsed > 0
      ? Math.min(parsed, 500)
      : 50;
  }
}

class RoomError extends Error {
  constructor(
    readonly code: ServerPayloads["error"]["code"],
    message: string,
  ) {
    super(message);
  }
}

function toWire(participant: ParticipantRecord): Participant {
  const { socketId: _socketId, lastSeenAt: _lastSeenAt, ...wire } = participant;
  void _socketId;
  void _lastSeenAt;
  return wire;
}

function roleOrder(role: Role): number {
  return { HOST: 0, CO_HOST: 1, EDITOR: 2, VIEWER: 3, GUEST: 4 }[role];
}

function languageFromPath(path: string): string {
  const extension = path.split(".").at(-1)?.toLocaleLowerCase();
  const languages: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    json: "json",
    css: "css",
    html: "html",
    md: "markdown",
    py: "python",
    rs: "rust",
    go: "go",
    java: "java",
    c: "c",
    cpp: "cpp",
    sh: "shell",
    yml: "yaml",
    yaml: "yaml",
  };
  return (extension && languages[extension]) || "plaintext";
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
