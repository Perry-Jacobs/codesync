/**
 * Cross-gateway filesystem smoke test.
 *
 * Requires two CodeSync gateways sharing one Redis namespace:
 *   SMOKE_APP_URL=http://localhost:3100
 *   SMOKE_WS_HOST_URL=ws://localhost:3101
 *   SMOKE_WS_GUEST_URL=ws://localhost:3121
 *
 * The host and guest deliberately connect to different processes. The guest
 * opens a file backed by the host's filesystem bridge, so the request and its
 * reply must be routed through Redis rather than process-local state.
 */
import { WebSocket } from "ws";
import type { ServerMessage, ServerType } from "@/lib/ws-protocol";

const APP = process.env.SMOKE_APP_URL ?? "http://localhost:3100";
const HOST_WS = process.env.SMOKE_WS_HOST_URL ?? "ws://localhost:3101";
const GUEST_WS = process.env.SMOKE_WS_GUEST_URL ?? "ws://localhost:3121";

let failures = 0;

function check(condition: unknown, label: string): void {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.error(`  ✗ ${label}`);
  }
}

class Peer {
  private readonly messages: ServerMessage[] = [];
  private readonly waiters: Array<{
    type: ServerType;
    predicate: (message: ServerMessage) => boolean;
    resolve: (message: ServerMessage) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  private constructor(
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

  static async connect(label: string, url: string): Promise<Peer> {
    const socket = new WebSocket(url);
    const peer = new Peer(label, socket);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new Error(`${label}: timed out connecting to ${url}`));
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
        id: `fs_multi_${Math.random().toString(36).slice(2)}`,
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
    timeoutMs = 10_000,
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

  hasMessage(
    type: ServerType,
    predicate: (message: ServerMessage) => boolean = () => true,
  ): boolean {
    return this.messages.some(
      (message) => message.type === type && predicate(message),
    );
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
    client: { supportsFs: true, appVersion: "fs-multi-smoke" },
  };
}

async function main(): Promise<void> {
  const create = await fetch(`${APP}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      hostName: "Cross Gateway Host",
      title: "Cross gateway filesystem test",
      admitMode: "auto",
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!create.ok) {
    throw new Error(
      `create room failed: ${create.status} ${await create.text()}`,
    );
  }
  const room = (await create.json()) as { roomKey: string; hostToken: string };

  const host = await Peer.connect("host", HOST_WS);
  host.send("join_room", joinPayload(room.roomKey, "Host", room.hostToken));
  await host.waitFor("room_state");
  await host.waitFor("admitted");

  const mtime = Date.now();
  host.send("fs_bridge_attach", {
    connected: true,
    rootName: "cross-gateway-fixture",
    snapshot: [{ path: "README.md", kind: "file", size: 13, mtime }],
  });
  await host.waitFor("workspace_reset");

  const guest = await Peer.connect("guest", GUEST_WS);
  guest.send("join_room", joinPayload(room.roomKey, "Guest"));
  const guestState = await guest.waitFor("room_state");
  await guest.waitFor("admitted");
  const file = guestState.data.files.find(
    (entry) => entry.path === "README.md",
  );
  check(Boolean(file), "guest sees the host's file metadata across gateways");
  if (!file) throw new Error("README.md metadata missing");

  const guestId = guestState.data.self.id;
  guest.send("file_op", {
    op: "open",
    fileId: file.fileId,
    path: file.path,
  });

  const denied = await guest.waitFor(
    "error",
    (message) => message.data.code === "FORBIDDEN",
  );
  check(
    denied.data.code === "FORBIDDEN",
    "viewer is denied access to the host-backed file",
  );

  await new Promise((resolve) => setTimeout(resolve, 300));
  check(
    !host.hasMessage(
      "fs_request",
      (message) =>
        message.type === "fs_request" &&
        message.data.op === "read" &&
        message.data.fileId === file.fileId,
    ),
    "host is not asked to read the file for the unauthorized viewer",
  );

  host.send("host_action", {
    action: "grant_edit",
    targetId: guestId,
  });
  await guest.waitFor(
    "permission_changed",
    (message) => message.data.participantId === guestId && message.data.canEdit,
  );
  check(true, "host grants edit access to the viewer");

  guest.send("file_op", {
    op: "open",
    fileId: file.fileId,
    path: file.path,
  });

  const request = await host.waitFor(
    "fs_request",
    (message) =>
      message.data.op === "read" && message.data.fileId === file.fileId,
  );
  check(Boolean(request), "host receives the authorized filesystem request");

  host.send("fs_file_content", {
    requestId: request.data.requestId,
    fileId: file.fileId,
    content: "Cross gateway\n",
    mtime,
  });

  const sync = await guest.waitFor(
    "yjs_sync",
    (message) =>
      message.data.fileId === file.fileId && message.data.kind === "snapshot",
  );
  check(Boolean(sync), "guest receives the file seeded by the other gateway");

  guest.close();
  host.close();
  if (failures > 0) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll cross-gateway filesystem checks passed.");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
