import assert from "node:assert/strict";
import { WebSocket } from "ws";
import * as Y from "yjs";

const BASE_URL = process.env.CF_RUNTIME_URL ?? "http://127.0.0.1:8787";
const WS_URL = BASE_URL.replace(/^http/, "ws");
const ORIGIN = process.env.CF_RUNTIME_ORIGIN ?? "http://localhost:3000";

interface ServerEnvelope {
  v: 1;
  id: string;
  type: string;
  ts: number;
  data: Record<string, unknown>;
}

type ClientType =
  | "join_room"
  | "chat_send"
  | "host_action"
  | "file_op"
  | "fs_bridge_attach"
  | "fs_file_content"
  | "yjs_update"
  | "yjs_sync_request"
  | "leave_room";

class TestSocket {
  readonly messages: ServerEnvelope[] = [];
  private sequence = 0;
  private readonly waiters: Array<{
    predicate: (message: ServerEnvelope) => boolean;
    resolve: (message: ServerEnvelope) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  private constructor(readonly socket: WebSocket) {
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as ServerEnvelope;
      this.messages.push(message);
      for (const waiter of [...this.waiters]) {
        if (!waiter.predicate(message)) continue;
        clearTimeout(waiter.timer);
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    });
  }

  static connect(roomKey: string): Promise<TestSocket> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(
        `${WS_URL}/ws?room=${encodeURIComponent(roomKey)}`,
        { origin: ORIGIN },
      );
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new Error("WebSocket connection timed out"));
      }, 8_000);
      socket.once("open", () => {
        clearTimeout(timer);
        resolve(new TestSocket(socket));
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  send<T extends ClientType>(type: T, data: unknown): void {
    this.socket.send(
      JSON.stringify({
        v: 1,
        id: `smoke-${++this.sequence}`,
        type,
        ts: Date.now(),
        data,
      }),
    );
  }

  waitFor(
    type: string,
    predicate: (message: ServerEnvelope) => boolean = () => true,
    timeoutMs = 8_000,
  ): Promise<ServerEnvelope> {
    const existing = this.messages.find(
      (message) => message.type === type && predicate(message),
    );
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(
          new Error(
            `Timed out waiting for ${type}; received: ${this.messages
              .map((message) => message.type)
              .join(", ")}`,
          ),
        );
      }, timeoutMs);
      const waiter = {
        predicate: (message: ServerEnvelope) =>
          message.type === type && predicate(message),
        resolve: (message: ServerEnvelope) => resolve(message),
        reject,
        timer,
      };
      this.waiters.push(waiter);
    });
  }

  hasMessage(
    type: string,
    predicate: (message: ServerEnvelope) => boolean = () => true,
  ): boolean {
    return this.messages.some(
      (message) => message.type === type && predicate(message),
    );
  }

  close(): void {
    this.socket.close();
  }

  terminate(): void {
    this.socket.terminate();
  }
}

async function createRoom(admitMode: "auto" | "manual") {
  const response = await fetch(`${BASE_URL}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({
      hostName: "Smoke Host",
      title: "Cloudflare runtime smoke",
      admitMode,
    }),
  });
  const responseText = await response.text();
  assert.equal(response.status, 201, responseText);
  return JSON.parse(responseText) as {
    roomKey: string;
    roomId: string;
    hostToken: string;
    joinUrl: string;
  };
}

async function join(
  socket: TestSocket,
  roomKey: string,
  displayName: string,
  credentials: { hostToken?: string; reconnectToken?: string } = {},
) {
  socket.send("join_room", {
    roomKey,
    displayName,
    ...credentials,
    media: { mic: false, cam: false },
    client: { supportsFs: false, appVersion: "cf-smoke" },
  });
  await socket.waitFor("room_state");
}

async function verifyLocalFilesystemPrivacy(): Promise<void> {
  const created = await createRoom("auto");
  const host = await TestSocket.connect(created.roomKey);
  const guest = await TestSocket.connect(created.roomKey);

  try {
    await join(host, created.roomKey, "Privacy Host", {
      hostToken: created.hostToken,
    });
    const hostState = await host.waitFor("room_state");
    const hostParticipant = hostState.data.self as {
      id: string;
      role: string;
    };

    await join(guest, created.roomKey, "Privacy Viewer");
    const guestState = await guest.waitFor("room_state");
    const guestParticipant = guestState.data.self as {
      id: string;
      role: string;
    };
    assert.equal(guestParticipant.role, "VIEWER");

    const mtime = Date.now();
    host.send("fs_bridge_attach", {
      connected: true,
      rootName: "private-fixture",
      snapshot: [{ path: "secret.txt", kind: "file", size: 6, mtime }],
    });
    const reset = await host.waitFor("workspace_reset");
    const fileId = (reset.data.files as Array<{ fileId: string }>)[0].fileId;

    guest.send("file_op", {
      op: "open",
      fileId,
      path: "secret.txt",
    });
    const denied = await guest.waitFor(
      "error",
      (message) => message.data.code === "FORBIDDEN",
    );
    assert.equal(denied.data.code, "FORBIDDEN");

    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(
      host.hasMessage("fs_request", (message) => message.data.op === "read"),
      false,
      "unauthorized viewer must not trigger a host filesystem read",
    );

    host.send("host_action", {
      action: "grant_edit",
      targetId: guestParticipant.id,
    });
    await guest.waitFor(
      "permission_changed",
      (message) =>
        message.data.participantId === guestParticipant.id &&
        message.data.canEdit === true,
    );

    guest.send("file_op", {
      op: "open",
      fileId,
      path: "secret.txt",
    });
    const request = await host.waitFor(
      "fs_request",
      (message) => message.data.op === "read",
    );
    assert.equal(hostParticipant.role, "HOST");

    host.send("fs_file_content", {
      requestId: request.data.requestId,
      fileId,
      content: "secret",
      mtime,
    });
    await guest.waitFor(
      "yjs_sync",
      (message) =>
        message.data.fileId === fileId && message.data.kind === "snapshot",
    );
  } finally {
    host.close();
    guest.close();
  }
}

async function main() {
  const created = await createRoom("manual");
  const host = await TestSocket.connect(created.roomKey);
  const guest = await TestSocket.connect(created.roomKey);

  try {
    await join(host, created.roomKey, "Smoke Host", {
      hostToken: created.hostToken,
    });
    const hostState = await host.waitFor("room_state");
    const hostParticipant = hostState.data.self as {
      id: string;
      role: string;
    };
    assert.equal(hostParticipant.role, "HOST");

    await join(guest, created.roomKey, "Smoke Guest");
    const guestState = await guest.waitFor("room_state");
    const guestParticipant = guestState.data.self as {
      id: string;
      state: string;
    };
    assert.equal(guestParticipant.state, "WAITING");
    const waiting = await host.waitFor("waiting_room");
    assert.ok(
      (waiting.data.waiting as Array<{ id: string }>).some(
        (participant) => participant.id === guestParticipant.id,
      ),
    );

    host.send("chat_send", {
      body: "Admitted participants only",
      clientMsgId: "waiting-privacy",
    });
    await host.waitFor(
      "chat_message",
      (message) =>
        (message.data.message as { body?: string }).body ===
        "Admitted participants only",
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(
      guest.hasMessage("chat_message"),
      false,
      "waiting-room sockets must not receive room broadcasts",
    );

    host.send("host_action", {
      action: "admit",
      targetId: guestParticipant.id,
      payload: { role: "VIEWER" },
    });
    const admitted = await guest.waitFor("admitted");
    assert.equal(
      (admitted.data.self as { id: string }).id,
      guestParticipant.id,
    );
    const guestReconnectToken = admitted.data.reconnectToken as string;
    assert.ok(guestReconnectToken.length >= 10);

    host.send("host_action", {
      action: "set_role",
      targetId: guestParticipant.id,
      payload: { role: "CO_HOST" },
    });
    await guest.waitFor(
      "permission_changed",
      (message) =>
        message.data.participantId === guestParticipant.id &&
        message.data.role === "CO_HOST",
    );

    host.send("host_action", {
      action: "revoke_edit",
      targetId: guestParticipant.id,
    });
    await guest.waitFor(
      "permission_changed",
      (message) =>
        message.data.participantId === guestParticipant.id &&
        message.data.canEdit === false,
    );
    guest.send("file_op", { op: "create", path: "revoked.ts" });
    const revokedEdit = await guest.waitFor(
      "error",
      (message) => message.data.code === "FORBIDDEN",
    );
    assert.equal(revokedEdit.data.code, "FORBIDDEN");

    guest.send("chat_send", {
      body: "Cloudflare smoke message",
      clientMsgId: "m1",
    });
    const chat = await host.waitFor(
      "chat_message",
      (message) =>
        (message.data.message as { body?: string }).body ===
        "Cloudflare smoke message",
    );
    assert.equal(
      (chat.data.message as { body: string }).body,
      "Cloudflare smoke message",
    );

    host.send("file_op", { op: "create", path: "src/main.ts" });
    const changed = await host.waitFor("file_changed");
    const fileId = (changed.data.meta as { fileId: string }).fileId;
    assert.match(fileId, /^f_/);

    guest.send("yjs_sync_request", { fileId });
    await guest.waitFor(
      "yjs_sync",
      (message) => message.data.fileId === fileId,
    );

    const source = new Y.Doc();
    source.getText("content").insert(0, "const answer = 42;\n");
    const update = Buffer.from(Y.encodeStateAsUpdate(source)).toString(
      "base64",
    );
    host.send("yjs_update", { fileId, update });

    const sync = await guest.waitFor(
      "yjs_sync",
      (message) =>
        message.data.fileId === fileId && message.data.kind === "diff",
    );
    const replica = new Y.Doc();
    Y.applyUpdate(replica, Buffer.from(sync.data.update as string, "base64"));
    assert.equal(replica.getText("content").toString(), "const answer = 42;\n");

    guest.terminate();
    const resumed = await TestSocket.connect(created.roomKey);
    await join(resumed, created.roomKey, "Smoke Guest", {
      reconnectToken: guestReconnectToken,
    });
    const resumedAdmitted = await resumed.waitFor("admitted");
    assert.equal(
      (resumedAdmitted.data.self as { id: string }).id,
      guestParticipant.id,
    );

    host.send("host_action", {
      action: "transfer_host",
      targetId: guestParticipant.id,
    });
    const transfer = await resumed.waitFor(
      "host_action",
      (message) =>
        message.data.action === "transfer_host" &&
        typeof (message.data.payload as { hostToken?: string } | undefined)
          ?.hostToken === "string",
    );
    const replacementToken = (transfer.data.payload as { hostToken: string })
      .hostToken;
    assert.ok(replacementToken.length >= 16);

    resumed.send("host_action", { action: "end_session" });
    const ended = await resumed.waitFor("room_ended");
    assert.equal(ended.data.reason, "host_ended");

    await verifyLocalFilesystemPrivacy();

    console.log("Cloudflare runtime smoke test passed");
    console.log(
      JSON.stringify(
        {
          roomKey: created.roomKey,
          roomId: created.roomId,
          checks: [
            "create",
            "host_join",
            "manual_waiting_room",
            "admit",
            "waiting_room_broadcast_privacy",
            "chat",
            "cohost_permission_revocation",
            "file_create",
            "yjs_convergence",
            "reconnect",
            "host_transfer",
            "end_session",
            "local_filesystem_privacy",
          ],
        },
        null,
        2,
      ),
    );
  } finally {
    host.close();
    guest.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
