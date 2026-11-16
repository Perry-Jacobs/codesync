import assert from "node:assert/strict";
import test from "node:test";
import { hasDifferentLiveSocket } from "./socket-ownership";

test("socket close preserves state only for a different live socket", () => {
  assert.equal(hasDifferentLiveSocket("replacement", "closing"), true);
  assert.equal(hasDifferentLiveSocket("closing", "closing"), false);
  assert.equal(hasDifferentLiveSocket(null, "closing"), false);
});
