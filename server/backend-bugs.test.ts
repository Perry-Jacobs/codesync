import assert from "node:assert/strict";
import test from "node:test";

import { quotaErrorMessage, quotaLimit, QuotaLimiter } from "./rate-limit";
import { reconnectRejection } from "./ws/reconnect-policy";

test("reconnect restores only an admitted participant in an open room", () => {
  assert.equal(reconnectRejection("open", "ADMITTED"), null);
});

test("reconnect does not bypass manual admission", () => {
  assert.deepEqual(reconnectRejection("open", "WAITING"), {
    code: "NOT_ADMITTED",
    message: "This participant is waiting for host approval",
  });
});

test("reconnect does not enter a locked room", () => {
  assert.deepEqual(reconnectRejection("locked", "ADMITTED"), {
    code: "ROOM_LOCKED",
    message: "The host locked this session",
  });
});

test("reconnect does not resurrect a departed or denied participant", () => {
  for (const state of ["LEFT", "REMOVED", "DENIED"] as const) {
    assert.equal(reconnectRejection("open", state)?.code, "FORBIDDEN");
  }
  assert.equal(reconnectRejection("open", null)?.code, "FORBIDDEN");
});

test("quota errors use the configured limit and hide the wire type", () => {
  assert.equal(quotaLimit("chat_send"), 5);
  assert.equal(
    quotaErrorMessage("chat_send"),
    "Slow down — you can send 5 chat messages at a time",
  );
  assert.equal(quotaErrorMessage("chat_send").includes("chat_send"), false);
});

test("quota limiter rejects messages beyond the configured limit", () => {
  const limiter = new QuotaLimiter();
  for (let index = 0; index < 5; index += 1) {
    assert.equal(limiter.check("chat_send"), true);
  }
  assert.equal(limiter.check("chat_send"), false);
});
