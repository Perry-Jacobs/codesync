import assert from "node:assert/strict";
import test from "node:test";
import {
  clearAllPresence,
  clearFilePresence,
  clearParticipantPresence,
  PRESENCE_TTL_MS,
  prunePresenceSnapshots,
  updatePresenceSnapshot,
  type FilePresenceState,
} from "../../workers/codesync/src/presence-state";
import {
  clearParticipantPresence as nodeClearParticipantPresence,
  PRESENCE_TTL_MS as NODE_PRESENCE_TTL_MS,
  prunePresenceSnapshots as nodePrunePresenceSnapshots,
  updatePresenceSnapshot as nodeUpdatePresenceSnapshot,
  type FilePresenceState as NodeFilePresenceState,
} from "./presence-state";

test("presence snapshots accumulate updates and expire after their TTL", () => {
  const state: FilePresenceState = {};
  updatePresenceSnapshot(
    state,
    "p1",
    "f1",
    { kind: "cursor", line: 4, column: 2 },
    100,
  );
  updatePresenceSnapshot(
    state,
    "p1",
    "f1",
    { kind: "selection", ranges: [] },
    200,
  );
  assert.deepEqual(state.f1?.p1?.cursor, {
    line: 4,
    column: 2,
    topLine: undefined,
  });
  assert.deepEqual(state.f1?.p1?.selection, []);
  prunePresenceSnapshots(state, 200 + PRESENCE_TTL_MS);
  assert.equal(state.f1, undefined);
});

test("presence cleanup removes a participant, a file, or all snapshots", () => {
  const state: FilePresenceState = {};
  updatePresenceSnapshot(
    state,
    "p1",
    "f1",
    { kind: "viewport", topLine: 4 },
    1,
  );
  updatePresenceSnapshot(
    state,
    "p2",
    "f1",
    { kind: "viewport", topLine: 8 },
    1,
  );
  updatePresenceSnapshot(
    state,
    "p1",
    "f2",
    { kind: "viewport", topLine: 2 },
    1,
  );
  clearParticipantPresence(state, "p1");
  assert.deepEqual(Object.keys(state.f1 ?? {}), ["p2"]);
  assert.equal(state.f2, undefined);
  clearFilePresence(state, "f1");
  assert.deepEqual(state, {});
  updatePresenceSnapshot(
    state,
    "p2",
    "f3",
    { kind: "viewport", topLine: 1 },
    1,
  );
  clearAllPresence(state);
  assert.deepEqual(state, {});
});

test("presence snapshots stay bounded by file and participant caps", () => {
  const state: FilePresenceState = {};
  for (let i = 0; i < 505; i += 1) {
    updatePresenceSnapshot(
      state,
      `p${i}`,
      "f1",
      { kind: "viewport", topLine: i },
      i,
    );
  }
  assert.equal(Object.keys(state.f1 ?? {}).length, 500);
  for (let i = 0; i < 40; i += 1) {
    updatePresenceSnapshot(
      state,
      "p",
      `f${i}`,
      { kind: "viewport", topLine: i },
      10_000 + i,
    );
  }
  assert.ok(Object.keys(state).length <= 32);
});

test("Node and Worker presence stores stay equivalent", () => {
  assert.equal(NODE_PRESENCE_TTL_MS, PRESENCE_TTL_MS);

  const worker: FilePresenceState = {};
  const node: NodeFilePresenceState = {};
  const updates = [
    {
      participantId: "p1",
      fileId: "f1",
      update: { kind: "cursor" as const, line: 3, column: 5 },
    },
    {
      participantId: "p1",
      fileId: "f1",
      update: { kind: "selection" as const, ranges: [] },
    },
    {
      participantId: "p2",
      fileId: "f1",
      update: { kind: "viewport" as const, topLine: 9 },
    },
    {
      participantId: "p2",
      fileId: "f2",
      update: { kind: "cursor" as const, line: 1, column: 1 },
    },
  ];
  for (const entry of updates) {
    updatePresenceSnapshot(
      worker,
      entry.participantId,
      entry.fileId,
      entry.update,
      1_000,
    );
    nodeUpdatePresenceSnapshot(
      node,
      entry.participantId,
      entry.fileId,
      entry.update,
      1_000,
    );
  }
  assert.deepEqual(node, worker);

  nodeClearParticipantPresence(node, "p1");
  clearParticipantPresence(worker, "p1");
  assert.deepEqual(node, worker);

  nodePrunePresenceSnapshots(node, 1_000 + PRESENCE_TTL_MS);
  prunePresenceSnapshots(worker, 1_000 + PRESENCE_TTL_MS);
  assert.deepEqual(node, worker);
});

test("Node presence store replays only live snapshots for other participants", async () => {
  const { presenceForFile, recordPresence, clearParticipant } =
    await import("../../server/ws/presence-store");
  const roomId = "room-presence-replay";
  recordPresence(roomId, "viewer", "f1", {
    kind: "cursor",
    line: 0,
    column: 0,
  });
  recordPresence(roomId, "peer", "f1", {
    kind: "cursor",
    line: 7,
    column: 2,
    topLine: 5,
  });
  recordPresence(roomId, "peer", "f1", {
    kind: "selection",
    ranges: [{ startLine: 7, startColumn: 2, endLine: 8, endColumn: 0 }],
  });

  const replay = presenceForFile(roomId, "f1", "viewer");
  assert.deepEqual(replay, [
    {
      participantId: "peer",
      fileId: "f1",
      cursor: { line: 7, column: 2, topLine: 5 },
      selection: [{ startLine: 7, startColumn: 2, endLine: 8, endColumn: 0 }],
      viewport: undefined,
    },
  ]);

  clearParticipant(roomId, "peer");
  assert.deepEqual(presenceForFile(roomId, "f1", "viewer"), []);
});
