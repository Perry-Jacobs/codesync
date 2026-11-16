import assert from "node:assert/strict";
import test from "node:test";
import { ChatNotificationGate, chatNotificationFor } from "./chat-notification";
import type { ChatMessage } from "./ws-protocol";

const message: ChatMessage = {
  id: "c1",
  participantId: "p2",
  name: "Guest 2",
  body: "  Hello\n  from   the other side  ",
  at: 1,
};

test("chat notification formats a compact author and message preview", () => {
  assert.deepEqual(chatNotificationFor(message, "p1"), {
    title: "Guest 2",
    description: "Hello from the other side",
  });
  assert.equal(chatNotificationFor(message, "p2"), null);
});

test("chat notifications deduplicate message IDs and reset by room scope", () => {
  const gate = new ChatNotificationGate();
  assert.ok(gate.notificationFor(message, "p1", "room-a"));
  assert.equal(gate.notificationFor(message, "p1", "room-a"), null);
  assert.ok(gate.notificationFor(message, "p1", "room-b"));
});
