import assert from "node:assert/strict";
import test from "node:test";
import {
  addFileSubscription as addWorkerSubscription,
  clearFileSubscriptions as clearWorkerSubscriptions,
  removeFileSubscription as removeWorkerSubscription,
} from "../../workers/codesync/src/file-subscriptions";
import {
  addFileSubscription as addNodeSubscription,
  clearFileSubscriptions as clearNodeSubscriptions,
  removeSocketSubscriptions,
  type RoomFileSubscriptions,
} from "../../server/ws/file-subscriptions";

test("subscriptions deduplicate, remove deleted files, and re-add after reconnect", () => {
  const files: string[] = [];
  addWorkerSubscription(files, "file-a");
  addWorkerSubscription(files, "file-a");
  assert.deepEqual(files, ["file-a"]);

  removeWorkerSubscription(files, "file-a");
  assert.deepEqual(files, []);

  addWorkerSubscription(files, "file-a");
  assert.deepEqual(files, ["file-a"]);
});

test("disconnect and workspace reset clear all subscriptions", () => {
  const files = ["file-a", "file-b"];
  clearWorkerSubscriptions(files);
  assert.deepEqual(files, []);
});

test("Node gateway clears every subscriber of a deleted file", () => {
  const subscriptions: RoomFileSubscriptions = new Map();
  assert.equal(
    addNodeSubscription(subscriptions, "room-a", "file-a", "socket-1"),
    true,
  );
  assert.equal(
    addNodeSubscription(subscriptions, "room-a", "file-a", "socket-1"),
    false,
  );
  assert.equal(
    addNodeSubscription(subscriptions, "room-a", "file-a", "socket-2"),
    true,
  );
  addNodeSubscription(subscriptions, "room-a", "file-b", "socket-1");

  assert.deepEqual(
    clearNodeSubscriptions(subscriptions, "room-a", "file-a").sort(),
    ["socket-1", "socket-2"],
  );
  assert.deepEqual(
    removeSocketSubscriptions(subscriptions, "room-a", "socket-1"),
    ["file-b"],
  );
  assert.deepEqual([...(subscriptions.get("room-a")?.keys() ?? [])], []);
});
