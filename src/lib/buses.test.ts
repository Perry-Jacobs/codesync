import assert from "node:assert/strict";
import test from "node:test";
import { presenceBus, webrtcBus } from "./buses";
import type { ServerPayloads } from "./ws-protocol";

test("WebRTC bus buffers only unobserved signals and drains them once", () => {
  webrtcBus.clear();
  const missed: ServerPayloads["webrtc_signal"] = {
    fromId: "peer-a",
    signal: { type: "offer", sdp: "offer-sdp" },
  };
  const delivered: ServerPayloads["webrtc_signal"][] = [];

  webrtcBus.emit(missed);
  const unsubscribe = webrtcBus.on((signal) => delivered.push(signal));
  assert.deepEqual(delivered, [missed]);

  const live: ServerPayloads["webrtc_signal"] = {
    fromId: "peer-a",
    signal: { type: "candidate", candidate: { candidate: "candidate:1" } },
  };
  webrtcBus.emit(live);
  assert.deepEqual(delivered, [missed, live]);

  unsubscribe();
  webrtcBus.emit(missed);
  const remounted: ServerPayloads["webrtc_signal"][] = [];
  webrtcBus.on((signal) => remounted.push(signal));
  assert.deepEqual(remounted, [missed]);

  const current: ServerPayloads["webrtc_signal"] = {
    fromId: "peer-b",
    signal: { type: "answer", sdp: "answer-sdp" },
  };
  webrtcBus.emit(current);
  assert.deepEqual(remounted, [missed, current]);
  webrtcBus.clear();
});

test("presence bus replays the latest snapshot missed before subscribing", () => {
  presenceBus.clear();
  const delivered: unknown[] = [];

  // The gateway replays stored presence during file open, which can land before
  // the editor finishes mounting and subscribes.
  presenceBus.emit({
    kind: "cursor",
    participantId: "p1",
    fileId: "f1",
    line: 2,
    column: 0,
  });
  presenceBus.emit({
    kind: "cursor",
    participantId: "p1",
    fileId: "f1",
    line: 9,
    column: 4,
  });

  const unsubscribe = presenceBus.on((event) => delivered.push(event));
  // Coalesced by participant/file/kind: only the newest position is replayed.
  assert.deepEqual(delivered, [
    { kind: "cursor", participantId: "p1", fileId: "f1", line: 9, column: 4 },
  ]);

  presenceBus.emit({
    kind: "viewport",
    participantId: "p1",
    fileId: "f1",
    topLine: 1,
  });
  assert.equal(delivered.length, 2);
  unsubscribe();
  presenceBus.clear();
});

test("presence bus keeps cursor and selection buffered independently", () => {
  presenceBus.clear();
  presenceBus.emit({
    kind: "cursor",
    participantId: "p1",
    fileId: "f1",
    line: 1,
    column: 1,
  });
  presenceBus.emit({
    kind: "selection",
    participantId: "p1",
    fileId: "f1",
    ranges: [],
  });
  const delivered: string[] = [];
  const unsubscribe = presenceBus.on((event) => delivered.push(event.kind));
  assert.deepEqual(delivered.sort(), ["cursor", "selection"]);
  unsubscribe();
  presenceBus.clear();
});

test("presence cleanup prevents buffered cursor snapshots from being replayed", () => {
  presenceBus.clear();
  presenceBus.emit({
    kind: "cursor",
    participantId: "leaving",
    fileId: "f1",
    line: 4,
    column: 2,
  });
  presenceBus.emit({
    kind: "cursor",
    participantId: "remaining",
    fileId: "f1",
    line: 8,
    column: 1,
  });
  presenceBus.emit({ kind: "clear-participant", participantId: "leaving" });

  const replayed: string[] = [];
  const unsubscribe = presenceBus.on((event) => {
    if ("participantId" in event) replayed.push(event.participantId);
  });
  assert.deepEqual(replayed, ["remaining"]);
  unsubscribe();
  presenceBus.clear();
});

test("presence cleanup reaches active listeners and clears all buffered snapshots", () => {
  presenceBus.clear();
  presenceBus.emit({
    kind: "cursor",
    participantId: "p1",
    fileId: "f1",
    line: 4,
    column: 2,
  });
  const events: string[] = [];
  const unsubscribe = presenceBus.on((event) => events.push(event.kind));
  presenceBus.emit({ kind: "clear-all" });
  presenceBus.emit({
    kind: "cursor",
    participantId: "p2",
    fileId: "f1",
    line: 5,
    column: 2,
  });
  assert.deepEqual(events, ["cursor", "clear-all", "cursor"]);
  unsubscribe();

  const replayed: string[] = [];
  presenceBus.on((event) => {
    if ("participantId" in event) replayed.push(event.participantId);
  });
  assert.deepEqual(replayed, []);
  presenceBus.clear();
});
