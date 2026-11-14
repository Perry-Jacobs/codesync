"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { FolderPlus, HardDrive, Plus, RotateCw } from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/components/providers/session-provider";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  FileTreeRow,
  type FileDialogMode,
} from "@/components/room/FileTreeRow";
import type { HostWorkspaceApi } from "@/hooks/useHostWorkspace";
import { hasCapability } from "@/lib/acl";
import {
  ancestorPaths,
  buildFileTree,
  isValidEntryName,
  joinPath,
  type TreeNode,
} from "@/lib/file-tree";
import { useRoomStore } from "@/stores/room.store";
import { useWorkspaceStore } from "@/stores/workspace.store";

interface DialogState {
  mode: FileDialogMode;
  target: string;
}

function baseName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

function parentOf(path: string): string {
  return path.split("/").filter(Boolean).slice(0, -1).join("/");
}

export function FileTree({ host }: { host: HostWorkspaceApi }) {
  const { send } = useSession();
  const files = useWorkspaceStore((state) => state.files);
  const activeFileId = useWorkspaceStore((state) => state.activeFileId);
  const openFile = useWorkspaceStore((state) => state.openFile);
  const self = useRoomStore((state) => state.self);
  const mode = useWorkspaceStore((state) => state.mode);
  const canEdit = hasCapability(self, "edit_code");
  const canOpenLocalFiles = mode !== "local-fs" || canEdit;
  const isHost = self?.role === "HOST";

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TreeNode | null>(null);
  const [nameInput, setNameInput] = useState("");
  const [dragPath, setDragPath] = useState<string | null>(null);
  const nameInputId = useId();
  const initialized = useRef(false);

  const tree = useMemo(() => buildFileTree(files), [files]);
  const activeFile = files.find((file) => file.fileId === activeFileId) ?? null;

  // First load: open every folder so the workspace is visible at a glance.
  useEffect(() => {
    if (initialized.current || files.length === 0) return;
    initialized.current = true;
    setExpanded(
      new Set(
        files.filter((file) => file.kind === "dir").map((file) => file.path),
      ),
    );
  }, [files]);

  // Keep the active file's ancestors open.
  useEffect(() => {
    if (!activeFile) return;
    setExpanded((previous) => {
      const next = new Set(previous);
      for (const path of ancestorPaths(activeFile.path)) next.add(path);
      return next;
    });
  }, [activeFile]);

  const toggle = (path: string): void => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const openEntry = (node: TreeNode): void => {
    if (node.kind === "dir") {
      toggle(node.path);
      return;
    }
    if (!node.meta) return;
    if (!canOpenLocalFiles) {
      toast.error("The host has not granted you access to this local folder");
      return;
    }
    openFile({ fileId: node.meta.fileId, path: node.meta.path });
    send("file_op", {
      op: "open",
      fileId: node.meta.fileId,
      path: node.meta.path,
    });
  };

  const startDialog = (mode: FileDialogMode, target: string): void => {
    if (!canEdit) {
      toast.error("You do not have edit access");
      return;
    }
    setDialog({ mode, target });
    setNameInput(mode === "rename" ? baseName(target) : "");
  };

  const submitDialog = (): void => {
    if (!dialog) return;
    const name = nameInput.trim();
    if (!isValidEntryName(name)) {
      toast.error("Use a simple name without slashes");
      return;
    }
    if (dialog.mode === "create-file" || dialog.mode === "create-dir") {
      const path = joinPath(dialog.target, name);
      send("file_op", {
        op: dialog.mode === "create-dir" ? "mkdir" : "create",
        path,
      });
      setExpanded((previous) => new Set(previous).add(dialog.target));
    } else {
      if (name === baseName(dialog.target)) {
        setDialog(null);
        return;
      }
      send("file_op", {
        op: "rename",
        path: dialog.target,
        toPath: joinPath(parentOf(dialog.target), name),
      });
    }
    setDialog(null);
  };

  const remove = (node: TreeNode): void => {
    if (!canEdit) return;
    setDeleteTarget(node);
  };

  const confirmDelete = (): void => {
    if (!deleteTarget) return;
    send("file_op", { op: "delete", path: deleteTarget.path });
    setDeleteTarget(null);
  };

  const moveTo = (from: string, targetDir: string): void => {
    if (!canEdit || !from) return;
    if (from === targetDir) return;
    if (targetDir && from.startsWith(`${targetDir}/`)) return;
    const toPath = joinPath(targetDir, baseName(from));
    if (toPath === from) return;
    send("file_op", { op: "move", path: from, toPath });
  };

  const rootName = useWorkspaceStore((state) => state.rootName);

  return (
    <aside className="flex h-full w-full flex-col bg-transparent">
      <header className="flex h-10 shrink-0 items-center gap-1 border-b border-border bg-muted/20 px-2.5">
        <span className="truncate text-[11px] font-semibold uppercase tracking-wider text-foreground/80">
          {host.rootName ?? rootName ?? "Explorer"}
        </span>
        <div className="ml-auto flex items-center gap-0.5">
          {isHost ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="h-6 w-6"
                  onClick={() => {
                    if (host.connected) void host.disconnect();
                    else if (host.savedName) void host.reconnect();
                    else void host.connect();
                  }}
                  disabled={host.busy}
                >
                  {host.connected ? (
                    <HardDrive className="h-3.5 w-3.5 text-emerald-400" />
                  ) : host.savedName ? (
                    <RotateCw className="h-3.5 w-3.5 text-amber-400" />
                  ) : (
                    <HardDrive className="h-3.5 w-3.5" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {host.connected
                  ? `Disconnect “${host.rootName}”`
                  : host.savedName
                    ? `Reconnect “${host.savedName}”`
                    : "Open a local folder"}
              </TooltipContent>
            </Tooltip>
          ) : null}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="h-6 w-6"
                onClick={() => startDialog("create-file", "")}
                disabled={!canEdit}
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>New file</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="h-6 w-6"
                onClick={() => startDialog("create-dir", "")}
                disabled={!canEdit}
              >
                <FolderPlus className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>New folder</TooltipContent>
          </Tooltip>
        </div>
      </header>

      <div
        role="tree"
        aria-label="Workspace files"
        className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-1 py-1.5"
        onDragOver={(event) => {
          if (!dragPath) return;
          event.preventDefault();
        }}
        onDrop={(event) => {
          event.preventDefault();
          const from = event.dataTransfer.getData("text/plain") || dragPath;
          if (from) moveTo(from, "");
          setDragPath(null);
        }}
      >
        {tree.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-3 py-8 text-center text-xs leading-relaxed text-muted-foreground">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-muted/50 text-muted-foreground">
              <HardDrive className="h-4 w-4" />
            </span>
            <p className="text-sm font-medium text-foreground">
              This workspace is empty
            </p>
            {isHost ? (
              host.connected ? (
                <>
                  <p>
                    “{host.rootName}” is connected but has no files. Create one
                    with the buttons above, or drop files into the folder and
                    reopen it.
                  </p>
                  <Button
                    size="sm"
                    className="h-7 gap-1.5 text-[11px]"
                    disabled={!canEdit}
                    onClick={() => startDialog("create-file", "")}
                  >
                    <Plus className="h-3.5 w-3.5" /> New file
                  </Button>
                </>
              ) : (
                <>
                  <p>
                    Open a folder from your computer to share the real files, or
                    create one with the buttons above.
                  </p>
                  {host.supported ? (
                    host.savedName ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 gap-1.5 text-[11px]"
                        disabled={host.busy}
                        onClick={() => void host.reconnect()}
                      >
                        <RotateCw className="h-3.5 w-3.5" /> Reopen{" "}
                        {host.savedName}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        className="h-7 gap-1.5 text-[11px]"
                        disabled={host.busy}
                        onClick={() => void host.connect()}
                      >
                        <HardDrive className="h-3.5 w-3.5" /> Open folder
                      </Button>
                    )
                  ) : (
                    <p className="text-[10px]">
                      Folder access needs Chrome or Edge. You can still create
                      files here.
                    </p>
                  )}
                </>
              )
            ) : (
              <p>Waiting for the host to open a folder or create a file.</p>
            )}
          </div>
        ) : (
          tree.map((node) => (
            <FileTreeRow
              key={node.path}
              node={node}
              depth={0}
              activeFileId={activeFileId}
              expanded={expanded}
              dragPath={dragPath}
              canEdit={canEdit}
              onOpen={openEntry}
              onStartDialog={startDialog}
              onRemove={remove}
              onDragPath={setDragPath}
              onMove={moveTo}
            />
          ))
        )}
      </div>

      {isHost && !host.supported ? (
        <p className="border-t border-border px-3 py-2 text-[10px] leading-relaxed text-muted-foreground">
          Local folders need Chrome or Edge. Guests can still edit the shared
          workspace.
        </p>
      ) : null}

      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => !open && setDialog(null)}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {dialog?.mode === "rename"
                ? "Rename entry"
                : dialog?.mode === "create-dir"
                  ? "New folder"
                  : "New file"}
            </DialogTitle>
            <DialogDescription>
              {dialog?.target
                ? `Inside ${dialog.target}/`
                : "At the workspace root"}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor={nameInputId}>Name</Label>
            <Input
              id={nameInputId}
              autoFocus
              value={nameInput}
              onChange={(event) => setNameInput(event.target.value)}
              placeholder={dialog?.mode === "create-file" ? "notes.md" : "src"}
              onKeyDown={(event) => {
                if (event.key === "Enter") submitDialog();
              }}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button onClick={submitDialog}>
              {dialog?.mode === "rename" ? "Rename" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete {deleteTarget?.name}?</DialogTitle>
            <DialogDescription>
              {deleteTarget?.kind === "dir"
                ? "This folder and everything inside it will be deleted. This action cannot be undone."
                : "This file will be deleted. This action cannot be undone."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmDelete}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  );
}
