"use client";

import type {
  DirHandleLike,
  FsSnapshotEntry,
  MoveCapableHandle,
} from "./types";
import { MAX_CONTENT_CHARS } from "@/lib/ws-protocol";

const MAX_ENTRIES = 600;
const MAX_DEPTH = 10;
const MAX_FILE_BYTES = MAX_CONTENT_CHARS;

const IGNORED_NAMES = new Set([
  "node_modules",
  ".git",
  ".next",
  ".turbo",
  "dist",
  "build",
  "out",
  "coverage",
  ".cache",
  ".DS_Store",
  ".venv",
  "__pycache__",
  ".idea",
]);

export function supportsFileSystemAccess(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.showDirectoryPicker === "function"
  );
}

export async function pickWorkspaceFolder(): Promise<DirHandleLike | null> {
  if (!supportsFileSystemAccess()) return null;
  try {
    const handle = await window.showDirectoryPicker?.({
      id: "codesync-workspace",
      mode: "readwrite",
    });
    return (handle as DirHandleLike | undefined) ?? null;
  } catch {
    return null;
  }
}

export async function ensurePermission(
  handle: DirHandleLike,
  mode: "read" | "readwrite" = "readwrite",
  request = false,
): Promise<boolean> {
  const typed = handle as DirHandleLike;
  try {
    if (typed.queryPermission) {
      const current = await typed.queryPermission({ mode });
      if (current === "granted") return true;
      if (!request || current === "denied") return false;
    }
    if (request && typed.requestPermission) {
      return (await typed.requestPermission({ mode })) === "granted";
    }
    return !typed.queryPermission;
  } catch {
    return false;
  }
}

export function isIgnored(name: string): boolean {
  return IGNORED_NAMES.has(name) || name.startsWith(".git");
}

export async function buildSnapshot(
  root: DirHandleLike,
): Promise<FsSnapshotEntry[]> {
  const entries: FsSnapshotEntry[] = [];

  const walk = async (
    directory: DirHandleLike,
    prefix: string,
    depth: number,
  ): Promise<void> => {
    if (depth > MAX_DEPTH || entries.length >= MAX_ENTRIES) return;
    for await (const handle of directory.values()) {
      if (entries.length >= MAX_ENTRIES) return;
      const name = handle.name;
      if (isIgnored(name)) continue;
      const path = prefix ? `${prefix}/${name}` : name;
      if (handle.kind === "directory") {
        entries.push({ path, kind: "dir", size: 0, mtime: Date.now() });
        await walk(handle as unknown as DirHandleLike, path, depth + 1);
      } else {
        try {
          const file = await (handle as FileSystemFileHandle).getFile();
          entries.push({
            path,
            kind: "file",
            size: file.size,
            mtime: file.lastModified,
          });
        } catch {
          // Unreadable entry (permissions/locked file): keep it out of the tree.
        }
      }
    }
  };

  await walk(root, "", 0);
  return entries;
}

export function pathSegments(path: string): string[] {
  if (
    !path ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("\\") ||
    path.includes("\0")
  ) {
    throw new Error("Invalid path");
  }
  const segments = path.split("/");
  if (
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("Invalid path");
  }
  return segments;
}

export async function resolveDirectory(
  root: DirHandleLike,
  path: string,
): Promise<DirHandleLike> {
  let current = root;
  if (path === "") return current;
  for (const segment of pathSegments(path)) {
    current = await current.getDirectoryHandle(segment);
  }
  return current;
}

export async function resolveParent(
  root: DirHandleLike,
  path: string,
): Promise<{ parent: DirHandleLike; name: string }> {
  const segments = pathSegments(path);
  const name = segments.pop();
  if (!name) throw new Error("Invalid path");
  const parent = await resolveDirectory(root, segments.join("/"));
  return { parent, name };
}

export async function readTextFile(
  root: DirHandleLike,
  path: string,
): Promise<string> {
  const { parent, name } = await resolveParent(root, path);
  const handle = await parent.getFileHandle(name);
  const file = await handle.getFile();
  if (file.size > MAX_FILE_BYTES) {
    throw new Error("File is too large to open in the editor");
  }
  return file.text();
}

export async function writeTextFile(
  root: DirHandleLike,
  path: string,
  content: string,
): Promise<void> {
  const { parent, name } = await resolveParent(root, path);
  if (content.length > MAX_CONTENT_CHARS) {
    throw new Error("File content is too large to write");
  }
  const handle = await parent.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(content);
  await writable.close();
}

export async function createEntry(
  root: DirHandleLike,
  path: string,
  kind: "file" | "dir",
): Promise<void> {
  const { parent, name } = await resolveParent(root, path);
  if (kind === "dir") await parent.getDirectoryHandle(name, { create: true });
  else await parent.getFileHandle(name, { create: true });
}

export async function removeEntry(
  root: DirHandleLike,
  path: string,
): Promise<void> {
  const { parent, name } = await resolveParent(root, path);
  await parent.removeEntry(name, { recursive: true });
}

export async function renameEntry(
  root: DirHandleLike,
  from: string,
  to: string,
): Promise<void> {
  const { parent, name } = await resolveParent(root, from);
  const destinationParentPath = pathSegments(to).slice(0, -1).join("/");
  const destinationName = pathSegments(to).pop() ?? "";
  if (!destinationName) throw new Error("Invalid destination");

  const source = await parent
    .getFileHandle(name, { create: false })
    .catch(() => parent.getDirectoryHandle(name, { create: false }))
    .catch(() => null);
  if (!source) throw new Error("Entry no longer exists on disk");

  const movable = source as MoveCapableHandle;
  if (typeof movable.move !== "function") {
    throw new Error(
      "This browser cannot move files. Rename from your file explorer.",
    );
  }
  const destinationParent = await resolveDirectory(root, destinationParentPath);
  await movable.move(destinationParent, destinationName);
}
