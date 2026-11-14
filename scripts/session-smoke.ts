/**
 * Host + two guests smoke test with precise workspace-save lifecycle checks.
 *
 * Requires the isolated preview gateway and Redis:
 *   SMOKE_APP_URL=http://localhost:3100
 *   SMOKE_WS_URL=ws://localhost:3101
 *   npm run ws:session-smoke
 */
import { WebSocket } from "ws";

import type { ServerMessage, ServerType } from "@/lib/ws-protocol";

const APP = process.env.SMOKE_APP_URL ?? "http://localhost:3100";
const WS = process.env.SMOKE_WS_URL ?? "ws://localhost:3101";

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
        id: `session_smoke_${Math.random().toString(36).slice(2)}`,
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
    timeoutMs = 8000,
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
        const recent = this.messages
          .slice(-12)
          .map((message) => `${message.type}:${JSON.stringify(message.data)}`)
          .join(" | ");
        reject(
          new Error(
            `${this.label}: timed out waiting for ${type}; recent=${recent}`,
          ),
        );
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

function joinPayload(roomKey: string, displayName: string, hostToken?: string) {
  return {
    roomKey,
    displayName,
    hostToken,
    media: { mic: false, cam: false },
    client: { supportsFs: true, appVersion: "session-smoke" },
  };
}

async function createRoom(hostName: string) {
  const response = await fetch(`${APP}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      hostName,
      title: "Host and two guests",
      admitMode: "auto",
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) {
    throw new Error(
      `create room failed: ${response.status} ${await response.text()}`,
    );
  }
  return (await response.json()) as {
    roomKey: string;
    hostToken: string;
  };
}

async function joinRoom(roomKey: string, hostToken?: string) {
  const host = await Peer.connect(hostToken ? "host" : "guest");
  host.send(
    "join_room",
    joinPayload(
      roomKey,
      hostToken ? "Session Host" : "Session Guest",
      hostToken,
    ),
  );
  const state = await host.waitFor("room_state");
  await host.waitFor("admitted");
  return { peer: host, state };
}

async function main(): Promise<void> {
  console.log("\n[1] host and two guests are admitted");
  const room = await createRoom("Session Host");
  const { peer: host, state: hostState } = await joinRoom(
    room.roomKey,
    room.hostToken,
  );
  const { peer: guestOne, state: guestOneState } = await joinRoom(room.roomKey);
  const { peer: guestTwo, state: guestTwoState } = await joinRoom(room.roomKey);

  check(hostState.data.self.role === "HOST", "host has the HOST role");
  check(guestOneState.data.self.role === "VIEWER", "guest one is admitted");
  check(guestTwoState.data.self.role === "VIEWER", "guest two is admitted");
  const participantJoined = await host.waitFor(
    "participant_joined",
    (message) => message.data.participant.id === guestTwoState.data.self.id,
  );
  check(Boolean(participantJoined), "host sees the second guest join");

  console.log("\n[2] permissions, cursor presence and chat");
  host.send("file_op", { op: "create", path: "cursor.txt" });
  const created = await host.waitFor(
    "file_changed",
    (message) =>
      message.data.op === "create" && message.data.path === "cursor.txt",
  );
  if (!created.data.meta) throw new Error("missing cursor file metadata");
  host.send("file_op", {
    op: "open",
    fileId: created.data.meta.fileId,
    path: created.data.meta.path,
  });
  await host.waitFor(
    "yjs_sync",
    (message) => message.data.fileId === created.data.meta?.fileId,
  );
  const guestOneId = guestOneState.data.self.id;
  host.send("host_action", { action: "grant_edit", targetId: guestOneId });
  await guestOne.waitFor(
    "permission_changed",
    (message) => message.data.canEdit === true,
  );
  guestOne.send("cursor_move", {
    fileId: created.data.meta.fileId,
    line: 4,
    column: 8,
  });
  const cursor = await host.waitFor(
    "cursor",
    (message) => message.data.participantId === guestOneId,
  );
  check(
    cursor.data.line === 4 && cursor.data.column === 8,
    "host receives guest cursor",
  );
  guestTwo.send("chat_send", {
    body: "hello from guest two",
    clientMsgId: "guest-two-chat",
  });
  const chat = await host.waitFor(
    "chat_message",
    (message) => message.data.message.body === "hello from guest two",
  );
  check(Boolean(chat), "host receives guest chat");

  console.log("\n[3] empty local-fs workspace reports empty, not failure");
  host.send("fs_bridge_attach", {
    connected: true,
    rootName: "empty-fixture",
    snapshot: [],
  });
  await host.waitFor(
    "workspace_reset",
    (message) => message.data.rootName === "empty-fixture",
  );
  host.send("host_action", {
    action: "save_workspace",
    payload: { operationId: "save_empty" },
  });
  const emptySave = await host.waitFor(
    "workspace_save",
    (message) =>
      message.data.operationId === "save_empty" &&
      message.data.phase !== "saving",
  );
  check(emptySave.data.phase === "empty", "empty save has the empty phase");
  check(
    !host.messages.some((message) => message.type === "error"),
    "empty save emits no error",
  );

  console.log("\n[4] one successful and one failed disk write reports partial");
  const mtime = Date.now();
  host.send("fs_bridge_attach", {
    connected: true,
    rootName: "partial-fixture",
    snapshot: [
      { path: "one.txt", kind: "file", size: 4, mtime },
      { path: "two.txt", kind: "file", size: 4, mtime },
    ],
  });
  const reset = await host.waitFor(
    "workspace_reset",
    (message) => message.data.rootName === "partial-fixture",
  );
  for (const file of reset.data.files) {
    console.log(`    opening ${file.path} (${file.fileId})`);
    // Match the real client flow: a guest opens the file while the host owns
    // the folder and answers the server's filesystem request.
    guestOne.send("file_op", {
      op: "open",
      fileId: file.fileId,
      path: file.path,
    });
    const read = await host.waitFor(
      "fs_request",
      (message) =>
        message.data.op === "read" && message.data.fileId === file.fileId,
    );
    console.log(`    answering read ${read.data.requestId}`);
    host.send("fs_file_content", {
      requestId: read.data.requestId,
      fileId: file.fileId,
      content: "test\n",
      mtime,
    });
    await guestOne.waitFor(
      "yjs_sync",
      (message) => message.data.fileId === file.fileId,
    );
    console.log(`    seeded ${file.path}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 150));

  host.send("host_action", {
    action: "save_workspace",
    payload: { operationId: "save_partial" },
  });
  const saving = await host.waitFor(
    "workspace_save",
    (message) =>
      message.data.operationId === "save_partial" &&
      message.data.phase === "saving",
  );
  check(Boolean(saving), "save emits an immediate saving phase");
  await new Promise((resolve) => setTimeout(resolve, 500));
  console.log(
    "    save diagnostics:",
    host.messages
      .filter((message) =>
        ["fs_request", "error", "workspace_save"].includes(message.type),
      )
      .map((message) => `${message.type}:${JSON.stringify(message.data)}`),
  );
  console.log("    waiting for write requests");
  const writeOne = await host.waitFor(
    "fs_request",
    (message) => message.data.op === "write" && message.data.path === "one.txt",
  );
  const writeTwo = await host.waitFor(
    "fs_request",
    (message) => message.data.op === "write" && message.data.path === "two.txt",
  );
  host.send("fs_ack", {
    requestId: writeOne.data.requestId,
    ok: true,
    fileId: writeOne.data.fileId,
    path: writeOne.data.path,
  });
  host.send("fs_ack", {
    requestId: writeTwo.data.requestId,
    ok: false,
    error: "fixture write failure",
    fileId: writeTwo.data.fileId,
    path: writeTwo.data.path,
  });
  const partialSave = await host.waitFor(
    "workspace_save",
    (message) =>
      message.data.operationId === "save_partial" &&
      message.data.phase !== "saving",
  );
  check(
    partialSave.data.phase === "partial",
    "mixed disk results report partial",
  );
  check(
    partialSave.data.saved === 1 && partialSave.data.failed === 1,
    "partial counts are exact",
  );
  check(
    partialSave.data.failures[0]?.path === "two.txt" &&
      partialSave.data.failures[0]?.error === "fixture write failure",
    "partial result includes the exact failed path and error",
  );
  check(
    !host.messages.some(
      (message) =>
        message.type === "error" &&
        message.data.message
          .toLowerCase()
          .includes("could not save every file"),
    ),
    "partial save emits no generic could-not-save error",
  );

  console.log("\n[5] all disk writes succeeding reports success");
  host.send("host_action", {
    action: "save_workspace",
    payload: { operationId: "save_success" },
  });
  await host.waitFor(
    "workspace_save",
    (message) =>
      message.data.operationId === "save_success" &&
      message.data.phase === "saving",
  );
  const successWriteOne = await host.waitFor(
    "fs_request",
    (message) =>
      message.data.op === "write" &&
      message.data.path === "one.txt" &&
      message.data.requestId !== writeOne.data.requestId,
  );
  const successWriteTwo = await host.waitFor(
    "fs_request",
    (message) =>
      message.data.op === "write" &&
      message.data.path === "two.txt" &&
      message.data.requestId !== writeTwo.data.requestId,
  );
  for (const request of [successWriteOne, successWriteTwo]) {
    host.send("fs_ack", {
      requestId: request.data.requestId,
      ok: true,
      fileId: request.data.fileId,
      path: request.data.path,
    });
  }
  const successSave = await host.waitFor(
    "workspace_save",
    (message) =>
      message.data.operationId === "save_success" &&
      message.data.phase !== "saving",
  );
  check(
    successSave.data.phase === "success",
    "successful disk results report success",
  );
  check(
    successSave.data.saved === 2 && successSave.data.failed === 0,
    "success counts are exact",
  );

  console.log("\n[6] host transfer rotates the durable credential");
  const transferGuestId = guestOneState.data.self.id;
  host.send("host_action", {
    action: "transfer_host",
    targetId: transferGuestId,
  });
  const transfer = await guestOne.waitFor(
    "host_action",
    (message) =>
      message.data.action === "transfer_host" &&
      typeof message.data.payload?.hostToken === "string",
  );
  const replacementToken = transfer.data.payload?.hostToken;
  check(
    typeof replacementToken === "string",
    "new host receives a replacement token",
  );

  guestOne.close();
  const oldTokenJoin = await Peer.connect("old-token-rejoin");
  oldTokenJoin.send(
    "join_room",
    joinPayload(room.roomKey, "Old Host Token", room.hostToken),
  );
  const oldTokenState = await oldTokenJoin.waitFor("room_state");
  check(
    oldTokenState.data.self.role !== "HOST",
    "old host token no longer identifies the host",
  );
  oldTokenJoin.close();

  const newHostReconnect = await Peer.connect("new-host-reconnect");
  newHostReconnect.send(
    "join_room",
    joinPayload(
      room.roomKey,
      "Replacement Host",
      typeof replacementToken === "string" ? replacementToken : undefined,
    ),
  );
  const newHostState = await newHostReconnect.waitFor("room_state");
  check(
    newHostState.data.self.role === "HOST",
    "replacement token reconnects as the new host",
  );
  await newHostReconnect.waitFor("admitted");
  newHostReconnect.close();

  host.close();
  guestOne.close();
  guestTwo.close();
  if (failures > 0) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll host + two guest session checks passed.");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
