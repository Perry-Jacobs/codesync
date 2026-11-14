export interface DirHandleLike {
  readonly kind: "directory";
  readonly name: string;
  values(): AsyncIterable<FileSystemHandle>;
  getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<FileSystemFileHandle>;
  getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<DirHandleLike>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  queryPermission?(descriptor?: {
    mode?: "read" | "readwrite";
  }): Promise<PermissionState>;
  requestPermission?(descriptor?: {
    mode?: "read" | "readwrite";
  }): Promise<PermissionState>;
}

export interface MoveCapableHandle {
  readonly kind: "file" | "directory";
  readonly name: string;
  move?(destination: DirHandleLike, newName: string): Promise<void>;
}

export interface FsSnapshotEntry {
  path: string;
  kind: "file" | "dir";
  size: number;
  mtime: number;
}
