import assert from "node:assert/strict";
import test from "node:test";
import { useWorkspaceStore } from "./workspace.store";
import type { FileMeta } from "@/lib/ws-protocol";

const entries: FileMeta[] = [
  {
    fileId: "src-dir",
    path: "src",
    kind: "dir",
    size: 0,
    mtime: 1,
    lang: "plaintext",
  },
  {
    fileId: "src-file",
    path: "src/index.ts",
    kind: "file",
    size: 10,
    mtime: 1,
    lang: "typescript",
  },
  {
    fileId: "src-old-file",
    path: "src-old/keep.ts",
    kind: "file",
    size: 5,
    mtime: 1,
    lang: "typescript",
  },
  {
    fileId: "archive-dir",
    path: "archive",
    kind: "dir",
    size: 0,
    mtime: 1,
    lang: "plaintext",
  },
];

test("setFiles refreshes retained tab paths and closes removed files", () => {
  const workspace = useWorkspaceStore.getState();
  workspace.reset(entries, "virtual", null);
  workspace.openFile({ fileId: "src-file", path: "src/index.ts" });
  workspace.openFile({ fileId: "src-old-file", path: "src-old/keep.ts" });

  workspace.setFiles([
    entries[0],
    { ...entries[1], path: "src/renamed.ts" },
    entries[3],
  ]);

  const state = useWorkspaceStore.getState();
  assert.deepEqual(state.tabs, [
    { fileId: "src-file", path: "src/renamed.ts" },
  ]);
  assert.equal(state.activeFileId, "src-file");
  workspace.clear();
});

test("workspace move updates directory descendants and open tabs only", () => {
  const workspace = useWorkspaceStore.getState();
  workspace.reset(entries, "virtual", null);
  workspace.openFile({ fileId: "src-file", path: "src/index.ts" });
  workspace.openFile({ fileId: "src-old-file", path: "src-old/keep.ts" });

  workspace.movePath("src", "archive/src", {
    ...entries[0],
    path: "archive/src",
  });

  const state = useWorkspaceStore.getState();
  assert.deepEqual(
    state.files.map(({ fileId, path }) => [fileId, path]),
    [
      ["archive-dir", "archive"],
      ["src-dir", "archive/src"],
      ["src-file", "archive/src/index.ts"],
      ["src-old-file", "src-old/keep.ts"],
    ],
  );
  assert.deepEqual(
    state.tabs.map(({ fileId, path }) => [fileId, path]),
    [
      ["src-file", "archive/src/index.ts"],
      ["src-old-file", "src-old/keep.ts"],
    ],
  );
  assert.equal(state.activeFileId, "src-old-file");
  workspace.clear();
});

test("deleting the active file closes it and falls back to a surviving tab", () => {
  const workspace = useWorkspaceStore.getState();
  workspace.reset(entries, "virtual", null);
  workspace.openFile({ fileId: "src-file", path: "src/index.ts" });
  workspace.openFile({ fileId: "src-old-file", path: "src-old/keep.ts" });

  workspace.removePath("src-old/keep.ts");

  let state = useWorkspaceStore.getState();
  assert.deepEqual(
    state.tabs.map(({ fileId }) => fileId),
    ["src-file"],
  );
  assert.equal(state.activeFileId, "src-file");
  assert.equal(
    state.files.some((file) => file.fileId === "src-old-file"),
    false,
  );

  // Deleting a folder takes every nested open tab with it.
  workspace.openFile({ fileId: "src-file", path: "src/index.ts" });
  workspace.removePath("src");
  state = useWorkspaceStore.getState();
  assert.deepEqual(state.tabs, []);
  assert.equal(state.activeFileId, null);
  workspace.clear();
});
