import assert from "node:assert/strict";
import test from "node:test";
import type {
  ServerMessage,
  ServerPayloads,
  ServerType,
} from "@/lib/ws-protocol";
import type { SocketContext } from "./connection";
import { applyRemoteRoomMessage } from "./remote-presence";
import { clearParticipant, presenceForFile } from "./presence-store";

function serverMessage<K extends ServerType>(
  type: K,
  data: ServerPayloads[K],
): ServerMessage {
  return {
    v: 1,
    id: `test-${type}`,
    type,
    ts: Date.now(),
    data,
  } as ServerMessage;
}

test("remote cursor messages populate the gateway replay cache", () => {
  const roomId = "room-remote-cursor-test";
  applyRemoteRoomMessage(
    roomId,
    serverMessage("cursor", {
      participantId: "editor",
      fileId: "file",
      line: 12,
      column: 4,
      topLine: 8,
    }),
    [],
  );

  assert.deepEqual(presenceForFile(roomId, "file", "viewer"), [
    {
      participantId: "editor",
      fileId: "file",
      cursor: { line: 12, column: 4, topLine: 8 },
      selection: undefined,
      viewport: undefined,
    },
  ]);
  clearParticipant(roomId, "editor");
});

test("remote participant leave clears that participant's replay cache", () => {
  const roomId = "room-remote-leave-test";
  applyRemoteRoomMessage(
    roomId,
    serverMessage("cursor", {
      participantId: "leaving",
      fileId: "file",
      line: 2,
      column: 1,
    }),
    [],
  );
  const cleanup = applyRemoteRoomMessage(
    roomId,
    serverMessage("participant_left", {
      participantId: "leaving",
      reason: "dropped",
    }),
    [],
  );

  assert.equal(cleanup.participantIdToClear, "leaving");
  assert.equal(cleanup.clearFileSubscriptions, true);

  assert.deepEqual(presenceForFile(roomId, "file", "viewer"), []);
});

test("remote permission changes refresh local ACL and clear revoked cursor state", () => {
  const roomId = "room-remote-permission-test";
  const participant = {
    id: "editor",
    name: "Editor",
    role: "EDITOR" as const,
    color: "blue",
    state: "ADMITTED" as const,
    canEdit: true,
    canSpeak: false,
    mic: false,
    cam: false,
    screen: false,
    handRaised: false,
    typing: false,
    joinedAt: 1,
    socketId: "socket-editor",
    lastSeenAt: 1,
  };
  const socket = { participant } as SocketContext;
  applyRemoteRoomMessage(
    roomId,
    serverMessage("cursor", {
      participantId: "editor",
      fileId: "file",
      line: 3,
      column: 1,
    }),
    [socket],
  );

  const cleanup = applyRemoteRoomMessage(
    roomId,
    serverMessage("permission_changed", {
      participantId: "editor",
      role: "VIEWER",
      canEdit: false,
      canSpeak: false,
      reason: "revoked_edit",
    }),
    [socket],
  );

  assert.equal(cleanup.participantIdToClear, "editor");
  assert.equal(cleanup.clearFileSubscriptions, false);
  assert.equal(socket.participant?.role, "VIEWER");
  assert.equal(socket.participant?.canEdit, false);
  assert.deepEqual(presenceForFile(roomId, "file", "viewer"), []);
  clearParticipant(roomId, "editor");
});

test("revoking a co-host edit grant clears remote presence", () => {
  const roomId = "room-cohost-revocation-test";
  const participant = {
    id: "cohost",
    name: "Co-host",
    role: "CO_HOST" as const,
    color: "blue",
    state: "ADMITTED" as const,
    canEdit: true,
    canSpeak: true,
    mic: false,
    cam: false,
    screen: false,
    handRaised: false,
    typing: false,
    joinedAt: 1,
    socketId: "socket-cohost",
    lastSeenAt: 1,
  };
  const socket = { participant } as SocketContext;
  applyRemoteRoomMessage(
    roomId,
    serverMessage("cursor", {
      participantId: "cohost",
      fileId: "file",
      line: 3,
      column: 1,
    }),
    [socket],
  );

  const cleanup = applyRemoteRoomMessage(
    roomId,
    serverMessage("permission_changed", {
      participantId: "cohost",
      role: "CO_HOST",
      canEdit: false,
      canSpeak: true,
      reason: "revoked_edit",
    }),
    [socket],
  );

  assert.equal(cleanup.participantIdToClear, "cohost");
  assert.equal(socket.participant?.role, "CO_HOST");
  assert.equal(socket.participant?.canEdit, false);
  assert.deepEqual(presenceForFile(roomId, "file", "viewer"), []);
  clearParticipant(roomId, "cohost");
});

test("permission change preserves edit capability provided by the new role", () => {
  const roomId = "room-role-permission-test";
  const participant = {
    id: "editor",
    name: "Editor",
    role: "VIEWER" as const,
    color: "blue",
    state: "ADMITTED" as const,
    canEdit: false,
    canSpeak: false,
    mic: false,
    cam: false,
    screen: false,
    handRaised: false,
    typing: false,
    joinedAt: 1,
    socketId: "socket-editor",
    lastSeenAt: 1,
  };
  const socket = { participant } as SocketContext;
  applyRemoteRoomMessage(
    roomId,
    serverMessage("cursor", {
      participantId: "editor",
      fileId: "file",
      line: 3,
      column: 1,
    }),
    [socket],
  );

  const cleanup = applyRemoteRoomMessage(
    roomId,
    serverMessage("permission_changed", {
      participantId: "editor",
      role: "EDITOR",
      canEdit: true,
      canSpeak: false,
      reason: "role:EDITOR",
    }),
    [socket],
  );

  assert.equal(cleanup.participantIdToClear, null);
  assert.equal(cleanup.clearFileSubscriptions, false);

  assert.equal(socket.participant?.role, "EDITOR");
  assert.deepEqual(presenceForFile(roomId, "file", "viewer").length, 1);
  clearParticipant(roomId, "editor");
});
