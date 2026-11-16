export type WorkspaceEntryKind = "file" | "dir";

export interface WorkspacePathEntry {
  path: string;
  kind: WorkspaceEntryKind;
}

export function moveWorkspacePath(
  path: string,
  from: string,
  to: string,
): string {
  if (path === from) return to;
  if (path.startsWith(`${from}/`)) return `${to}${path.slice(from.length)}`;
  return path;
}

export interface WorkspacePathConflictOptions {
  /** Ignore an entry and its descendants while validating a move target. */
  ignorePath?: string;
  /** Allow mkdir to make an implicit directory explicit. */
  allowImplicitDirectory?: boolean;
}

/**
 * Returns a conflict message when an entry cannot occupy a path. Flat file
 * lists imply directories from descendants, so exact-path checks are not
 * sufficient for file creation or moves.
 */
export function workspacePathConflict(
  entries: readonly WorkspacePathEntry[],
  candidatePath: string,
  options: WorkspacePathConflictOptions = {},
): string | null {
  for (const entry of entries) {
    if (
      options.ignorePath &&
      (entry.path === options.ignorePath ||
        entry.path.startsWith(`${options.ignorePath}/`))
    ) {
      continue;
    }
    if (entry.path === candidatePath) {
      return "That path already exists in the workspace";
    }
    if (entry.kind === "file" && candidatePath.startsWith(`${entry.path}/`)) {
      return "A file already exists in the destination path";
    }
    if (
      !options.allowImplicitDirectory &&
      entry.path.startsWith(`${candidatePath}/`)
    ) {
      return "That path already contains workspace entries";
    }
  }
  return null;
}

export function workspaceMoveConflict(
  entries: readonly WorkspacePathEntry[],
  sourcePath: string,
  destinationPath: string,
  kind: WorkspaceEntryKind,
): string | null {
  if (destinationPath.startsWith(`${sourcePath}/`)) {
    return kind === "dir"
      ? "Cannot move a folder inside itself"
      : "A file cannot be moved inside itself";
  }
  if (sourcePath.startsWith(`${destinationPath}/`)) {
    return "The destination is already an ancestor of this entry";
  }
  return workspacePathConflict(entries, destinationPath, {
    ignorePath: sourcePath,
  });
}
