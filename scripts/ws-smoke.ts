/**
 * End-to-end gateway smoke test. Requires Redis and `npm run dev` to be up.
 *
 *   npm run ws:smoke
 *
 * It exercises the parts that are easy to get wrong: host/guest admission,
 * server-side permission enforcement, Yjs convergence, chat, the waiting room
 * and ending a session.
 */
import { WebSocket } from "ws";
import * as Y from "yjs";
import type { ServerMessage, ServerType } from "@/lib/ws-protocol";

const APP = process.env.SMOKE_APP_URL ?? "http://localhost:3000";
const WS = process.env.SMOKE_WS_URL ?? "ws://localhost:3000/ws";

let failures = 0;

function check(condition: unknown, label: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${label}`);
  }
}

type Waiter = {
  type: ServerType;
  predicate: (message: ServerMessage) => boolean;
  resolve: (message: ServerMessage) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

class Peer {
  readonly messages: ServerMessage[] = [];
  readonly waiters: Waiter[] = [];

  constructor(
    readonly label: string,
    readonly socket: WebSocket,
  ) {
    socket.on("message", (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString()) as ServerMessage;
      this.messages.push(message);
      for (const waiter of [...this.waiters]) {
        if (waiter.type !== message.type || !waiter.predicate(message))
          continue;
        clearTimeout(waiter.timer);
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    });
  }

  static async connect(label: string): Promise<Peer> {
    const socket = new WebSocket(WS);
    const peer = new Peer(label, socket);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new Error(`${label}: timed out connecting to ${WS}`));
      }, 6000);
      socket.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    return peer;
  }

  send(type: string, data: unknown): void {
    this.socket.send(
      JSON.stringify({
        v: 1,
        id: `smoke_${Math.random().toString(36).slice(2)}`,
        type,
        ts: Date.now(),
        data,
      }),
    );
  }

  waitFor<T extends ServerType>(
    type: T,
    predicate: (message: Extract<ServerMessage, { type: T }>) => boolean = () =>
      true,
    timeoutMs = 6000,
  ): Promise<Extract<ServerMessage, { type: T }>> {
    const existing = this.messages.find(
      (message) => message.type === type && predicate(message as never),
    );
    if (existing) {
      this.messages.splice(this.messages.indexOf(existing), 1);
      return Promise.resolve(existing as Extract<ServerMessage, { type: T }>);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.splice(
          this.waiters.findIndex((entry) => entry.timer === timer),
          1,
        );
        reject(new Error(`${this.label}: timed out waiting for ${type}`));
      }, timeoutMs);
      this.waiters.push({
        type,
        predicate: predicate as never,
        resolve: resolve as never,
        reject,
        timer,
      });
    });
  }

  close(): void {
    this.socket.close();
  }
}

function joinPayload(
  roomKey: string,
  displayName: string,
  hostToken?: string,
  reconnectToken?: string,
) {
  return {
    roomKey,
    displayName,
    hostToken,
    reconnectToken,
    media: { mic: false, cam: false },
    client: { supportsFs: false, appVersion: "smoke" },
  };
}

function documentFor(content: string): { doc: Y.Doc; update: string } {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, content);
  const update = Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64");
  return { doc, update };
}

async function createRoom(hostName: string, admitMode: "auto" | "manual") {
  const response = await fetch(`${APP}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hostName, title: "Smoke session", admitMode }),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok)
    throw new Error(
      `create room failed: ${response.status} ${await response.text()}`,
    );
  return (await response.json()) as {
    roomKey: string;
    hostToken: string;
    roomId: string;
  };
}

async function main(): Promise<void> {
  console.log("\n[1] create + auto-admitted guest");
  const room = await createRoom("Smoke Host", "auto");
  const host = await Peer.connect("host");
  host.send(
    "join_room",
    joinPayload(room.roomKey, "Smoke Host", room.hostToken),
  );
  const hostState = await host.waitFor("room_state");
  await host.waitFor("admitted");
  check(hostState.data.self.role === "HOST", "host is HOST");
  check(hostState.data.files.length === 0, "workspace starts empty");

  const rapid = await Peer.connect("rapid-chat");
  rapid.send("join_room", joinPayload(room.roomKey, "Rapid Chat"));
  rapid.send("chat_send", {
    body: "chat sent immediately after join",
    clientMsgId: "rapid-1",
  });
  await rapid.waitFor("admitted");
  const rapidChat = await host.waitFor(
    "chat_message",
    (message) =>
      message.data.message.body === "chat sent immediately after join",
  );
  check(Boolean(rapidChat), "chat sent immediately after join is delivered");
  rapid.close();

  const guest = await Peer.connect("guest");
  guest.send("join_room", joinPayload(room.roomKey, "Smoke Guest"));
  const guestState = await guest.waitFor("room_state");
  const guestAdmission = await guest.waitFor("admitted");
  check(guestState.data.self.role === "VIEWER", "new guest is VIEWER");
  check(guestState.data.self.canEdit === false, "guest starts read-only");

  console.log(
    "\n[2] host creates a file, edit permission is enforced server-side",
  );
  host.send("file_op", { op: "create", path: "README.md" });
  const created = await host.waitFor(
    "file_changed",
    (message) =>
      message.data.op === "create" && message.data.path === "README.md",
  );
  const readme = created.data.meta;
  check(Boolean(readme), "host created README.md");
  if (!readme) throw new Error("missing README.md");
  const guestSaw = await guest.waitFor(
    "file_changed",
    (message) => message.data.path === "README.md",
  );
  check(
    guestSaw.data.meta?.fileId === readme.fileId,
    "guest received the new file",
  );

  guest.send("file_op", {
    op: "open",
    fileId: readme.fileId,
    path: readme.path,
  });
  await guest.waitFor("yjs_sync");
  const sneaky = documentFor("nope");
  guest.send("yjs_update", { fileId: readme.fileId, update: sneaky.update });
  const forbidden = await guest.waitFor("error");
  check(
    forbidden.data.code === "FORBIDDEN",
    "viewer yjs_update rejected with FORBIDDEN",
  );

  const guestId = guestState.data.self.id;
  host.send("host_action", { action: "grant_edit", targetId: guestId });
  const grant = await guest.waitFor("permission_changed");
  check(grant.data.canEdit === true, "host granted edit access");

  console.log("\n[3] Yjs convergence");
  host.send("file_op", {
    op: "open",
    fileId: readme.fileId,
    path: readme.path,
  });
  await host.waitFor("yjs_sync");
  const edit = documentFor("");
  edit.doc.getText("content").insert(0, "\n\nSmoke test edit");
  guest.send("yjs_update", {
    fileId: readme.fileId,
    update: Buffer.from(Y.encodeStateAsUpdate(edit.doc)).toString("base64"),
  });
  const synced = await host.waitFor(
    "yjs_sync",
    (message) => message.data.fileId === readme.fileId,
  );
  Y.applyUpdate(edit.doc, Buffer.from(synced.data.update, "base64"));
  // The host's snapshot arrives on open; the guest's update is a diff on top.
  check(
    edit.doc.getText("content").toString().includes("Smoke test edit"),
    "host received the edit",
  );

  console.log("\n[4] revoked permissions remain revoked");
  host.send("host_action", { action: "revoke_edit", targetId: guestId });
  const revoke = await guest.waitFor(
    "permission_changed",
    (message) => message.data.canEdit === false,
  );
  check(revoke.data.canEdit === false, "host revoked edit access");
  guest.send("yjs_update", { fileId: readme.fileId, update: sneaky.update });
  const revokedError = await guest.waitFor(
    "error",
    (message) => message.data.code === "FORBIDDEN",
  );
  check(
    revokedError.data.code === "FORBIDDEN",
    "stale editor update stays forbidden",
  );

  console.log("\n[5] chat");
  guest.send("chat_send", {
    body: "hello from the smoke test",
    clientMsgId: "smoke1",
  });
  const chat = await host.waitFor(
    "chat_message",
    (message) => message.data.message.body === "hello from the smoke test",
  );
  check(
    chat.data.message.body === "hello from the smoke test",
    "host received chat",
  );

  console.log("\n[6] waiting room");
  const manual = await createRoom("Manual Host", "manual");
  const manualHost = await Peer.connect("manual-host");
  manualHost.send(
    "join_room",
    joinPayload(manual.roomKey, "Manual Host", manual.hostToken),
  );
  await manualHost.waitFor("admitted");

  const waiting = await Peer.connect("waiting-guest");
  waiting.send("join_room", joinPayload(manual.roomKey, "Waiting Guest"));
  const waitingState = await waiting.waitFor("room_state");
  check(
    waitingState.data.self.state === "WAITING",
    "manual room puts guests in the waiting room",
  );
  const queue = await manualHost.waitFor("waiting_room");
  check(queue.data.waiting.length === 1, "host sees the waiting queue");

  manualHost.send("chat_send", {
    body: "chat that must not leak to the waiting room",
    clientMsgId: "waiting-isolation-host",
  });
  await manualHost.waitFor(
    "chat_message",
    (message) =>
      message.data.message.body ===
      "chat that must not leak to the waiting room",
  );
  await new Promise((resolve) => setTimeout(resolve, 150));
  check(
    !waiting.messages.some((message) => message.type === "chat_message"),
    "waiting participant receives no room chat",
  );
  waiting.send("chat_send", {
    body: "must be rejected before admission",
    clientMsgId: "waiting-chat",
  });
  const waitingChatError = await waiting.waitFor(
    "error",
    (message) => message.data.code === "NOT_ADMITTED",
  );
  check(
    waitingChatError.data.code === "NOT_ADMITTED",
    "waiting participant cannot send room chat",
  );

  manualHost.send("host_action", {
    action: "admit",
    targetId: waitingState.data.self.id,
    payload: { role: "EDITOR" },
  });
  const admitted = await waiting.waitFor("admitted");
  check(admitted.data.self.role === "EDITOR", "guest admitted as EDITOR");

  console.log("\n[7] locked room rejects new participants");
  const locked = await createRoom("Locked Host", "auto");
  const lockedHost = await Peer.connect("locked-host");
  lockedHost.send(
    "join_room",
    joinPayload(locked.roomKey, "Locked Host", locked.hostToken),
  );
  await lockedHost.waitFor("admitted");
  lockedHost.send("host_action", { action: "lock_room" });
  await lockedHost.waitFor(
    "host_action",
    (message) => message.data.action === "lock_room",
  );
  const blocked = await Peer.connect("blocked-guest");
  blocked.send("join_room", joinPayload(locked.roomKey, "Blocked Guest"));
  const lockedError = await blocked.waitFor(
    "error",
    (message) => message.data.code === "ROOM_LOCKED",
  );
  check(
    lockedError.data.code === "ROOM_LOCKED",
    "locked room rejects new guest",
  );
  blocked.close();
  lockedHost.close();

  console.log("\n[8] terminal participant state is immutable");
  host.send("host_action", { action: "kick", targetId: guestId });
  await guest.waitFor("kicked");
  const revokedReconnect = await Peer.connect("revoked-reconnect");
  revokedReconnect.send(
    "join_room",
    joinPayload(
      room.roomKey,
      "Removed Guest",
      undefined,
      guestAdmission.data.reconnectToken,
    ),
  );
  const reconnectError = await revokedReconnect.waitFor(
    "error",
    (message) => message.data.code === "FORBIDDEN",
  );
  check(
    reconnectError.data.message.includes("can no longer rejoin"),
    "removed participant cannot reconnect with an old token",
  );
  revokedReconnect.close();

  const prefix =
    process.env.SMOKE_REDIS_KEY_PREFIX ?? process.env.REDIS_KEY_PREFIX ?? "";
  process.env.REDIS_KEY_PREFIX = prefix;
  const { getParticipant, updateParticipant } =
    await import("../server/rooms/repository");
  const staleUpdate = await updateParticipant(room.roomId, guestId, {
    mic: true,
    canSpeak: true,
  });
  const removed = await getParticipant(room.roomId, guestId);
  check(staleUpdate === null, "stale update cannot mutate removed participant");
  check(removed?.state === "REMOVED", "removed participant stays removed");

  console.log("\n[9] end session");
  host.send("host_action", { action: "end_session" });
  const ended = await host.waitFor("room_ended");
  check(ended.data.reason === "host_ended", "host was told the session ended");
  const endedLookup = await fetch(`${APP}/api/rooms/${room.roomKey}`, {
    signal: AbortSignal.timeout(8000),
  });
  check(endedLookup.status === 410, "ended key lookup returns 410");

  host.close();
  guest.close();
  manualHost.close();
  waiting.close();

  console.log(
    failures === 0
      ? "\nAll smoke checks passed.\n"
      : `\n${failures} check(s) failed.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error("\nSmoke test crashed:", error);
  process.exit(1);
});
