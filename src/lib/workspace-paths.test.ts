import assert from "node:assert/strict";
import test from "node:test";
import {
  moveWorkspacePath as moveNodeWorkspacePath,
  workspaceMoveConflict as nodeWorkspaceMoveConflict,
  workspacePathConflict as nodeWorkspacePathConflict,
  type WorkspacePathEntry,
} from "./workspace-paths";
import {
  moveWorkspacePath as moveWorkerWorkspacePath,
  workspaceMoveConflict,
  workspacePathConflict,
} from "../../workers/codesync/src/workspace-paths";
import {
  buildFileTree,
  canMoveEntryToDirectory,
  directoryPaths,
} from "./file-tree";
import type { FileMeta } from "./ws-protocol";

const files: WorkspacePathEntry[] = [
  { path: "src/index.ts", kind: "file" },
  { path: "src/components/App.tsx", kind: "file" },
  { path: "README.md", kind: "file" },
];

test("file tree includes implicit and explicit folders for expansion", () => {
  const files: FileMeta[] = [
    {
      fileId: "file-a",
      path: "src/components/App.tsx",
      kind: "file",
      size: 0,
      mtime: 0,
      lang: "typescript",
    },
    {
      fileId: "dir-empty",
      path: "empty",
      kind: "dir",
      size: 0,
      mtime: 0,
      lang: "plaintext",
    },
  ];

  assert.deepEqual([...directoryPaths(buildFileTree(files))].sort(), [
    "empty",
    "src",
    "src/components",
  ]);
});

test("file creation rejects implicit directories and file parents", () => {
  assert.match(
    workspacePathConflict(files, "src", { allowImplicitDirectory: false }) ??
      "",
    /already contains/,
  );
  assert.match(
    workspacePathConflict(files, "README.md/child.ts") ?? "",
    /file already exists/,
  );
  assert.equal(workspacePathConflict(files, "src/new.ts"), null);
});

test("mkdir can formalize an implicit directory, but not a file", () => {
  assert.equal(
    workspacePathConflict(files, "src", { allowImplicitDirectory: true }),
    null,
  );
  assert.match(
    workspacePathConflict(files, "README.md", {
      allowImplicitDirectory: true,
    }) ?? "",
    /already exists/,
  );
});

test("file tree allows moving entries to ancestors but rejects self and descendants", () => {
  assert.equal(canMoveEntryToDirectory("src/components/App.tsx", "src"), true);
  assert.equal(canMoveEntryToDirectory("src/components", ""), true);
  assert.equal(
    canMoveEntryToDirectory("src/components", "src/components"),
    false,
  );
  assert.equal(canMoveEntryToDirectory("src", "src/nested"), false);
  assert.equal(canMoveEntryToDirectory("", "src"), false);
});

test("directory moves reject descendants and destination collisions", () => {
  assert.match(
    workspaceMoveConflict(files, "src", "src/nested", "dir") ?? "",
    /inside itself/,
  );
  assert.match(
    workspaceMoveConflict(files, "src", "README.md", "dir") ?? "",
    /already exists/,
  );
  assert.match(
    workspaceMoveConflict(files, "src/components", "src", "dir") ?? "",
    /ancestor/,
  );
});

test("moves can target a new path inside an existing directory", () => {
  const entries: WorkspacePathEntry[] = [
    ...files,
    { path: "archive", kind: "dir" },
    { path: "archive/notes.txt", kind: "file" },
  ];
  assert.equal(
    workspaceMoveConflict(entries, "src", "archive/src", "dir"),
    null,
  );
  assert.equal(
    workspaceMoveConflict(entries, "README.md", "archive/README.md", "file"),
    null,
  );
});

test("moving an entry ignores its own subtree while checking external conflicts", () => {
  const entries: WorkspacePathEntry[] = [
    { path: "old", kind: "dir" },
    { path: "old/a.ts", kind: "file" },
  ];
  assert.equal(workspaceMoveConflict(entries, "old", "new", "dir"), null);
});

test("path rewriting moves descendants without matching sibling prefixes", () => {
  const paths = ["src", "src/index.ts", "src-old/index.ts", "README.md"];
  const expected = [
    "archive/src",
    "archive/src/index.ts",
    "src-old/index.ts",
    "README.md",
  ];
  assert.deepEqual(
    paths.map((path) => moveNodeWorkspacePath(path, "src", "archive/src")),
    expected,
  );
  assert.deepEqual(
    paths.map((path) => moveWorkerWorkspacePath(path, "src", "archive/src")),
    expected,
  );
});

test("Node and Worker workspace path rules stay equivalent", () => {
  const scenarios: Array<{
    entries: WorkspacePathEntry[];
    from: string;
    to: string;
    kind: WorkspacePathEntry["kind"];
  }> = [
    { entries: files, from: "src", to: "src/nested", kind: "dir" },
    { entries: files, from: "src", to: "README.md", kind: "dir" },
    {
      entries: [...files, { path: "archive", kind: "dir" }],
      from: "src",
      to: "archive/src",
      kind: "dir",
    },
    {
      entries: [...files, { path: "archive/src/index.ts", kind: "file" }],
      from: "src",
      to: "archive/src",
      kind: "dir",
    },
  ];

  for (const scenario of scenarios) {
    assert.equal(
      nodeWorkspaceMoveConflict(
        scenario.entries,
        scenario.from,
        scenario.to,
        scenario.kind,
      ),
      workspaceMoveConflict(
        scenario.entries,
        scenario.from,
        scenario.to,
        scenario.kind,
      ),
    );
  }
  assert.equal(
    nodeWorkspacePathConflict(files, "src/new.ts"),
    workspacePathConflict(files, "src/new.ts"),
  );
  assert.equal(
    moveNodeWorkspacePath("src/index.ts", "src", "lib"),
    moveWorkerWorkspacePath("src/index.ts", "src", "lib"),
  );
});
