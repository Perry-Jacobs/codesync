"use client";

import type { ReactNode } from "react";
import {
  ChevronDown,
  ChevronRight,
  FileCode2,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Hash,
  Plus,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { entryExtension, type TreeNode } from "@/lib/file-tree";
import { cn } from "@/lib/utils";

export type FileDialogMode = "create-file" | "create-dir" | "rename";

interface FileTreeRowProps {
  node: TreeNode;
  depth: number;
  activeFileId: string | null;
  expanded: ReadonlySet<string>;
  dragPath: string | null;
  canEdit: boolean;
  onOpen(node: TreeNode): void;
  onStartDialog(mode: FileDialogMode, target: string): void;
  onRemove(node: TreeNode): void;
  onDragPath(path: string | null): void;
  onMove(from: string, targetDir: string): void;
}

function EntryIcon({
  path,
  kind,
  open,
}: {
  path: string;
  kind: "file" | "dir";
  open?: boolean;
}) {
  if (kind === "dir") {
    return open ? (
      <FolderOpen className="h-3.5 w-3.5 text-sky-400/80" />
    ) : (
      <Folder className="h-3.5 w-3.5 text-sky-400/80" />
    );
  }
  const extension = entryExtension(path);
  if (["json", "jsonc"].includes(extension)) {
    return <FileJson className="h-3.5 w-3.5 text-amber-300/80" />;
  }
  if (["css", "scss", "less"].includes(extension)) {
    return <Hash className="h-3.5 w-3.5 text-violet-300/80" />;
  }
  if (["md", "mdx", "txt"].includes(extension)) {
    return <FileText className="h-3.5 w-3.5 text-slate-300/80" />;
  }
  return <FileCode2 className="h-3.5 w-3.5 text-sky-300/80" />;
}

/** One tree row plus its open children. Recurses through itself. */
export function FileTreeRow({
  node,
  depth,
  activeFileId,
  expanded,
  dragPath,
  canEdit,
  onOpen,
  onStartDialog,
  onRemove,
  onDragPath,
  onMove,
}: FileTreeRowProps): ReactNode {
  const isOpen = expanded.has(node.path);
  const active = node.kind === "file" && node.meta?.fileId === activeFileId;

  return (
    <div>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            role="treeitem"
            aria-selected={active}
            aria-expanded={node.kind === "dir" ? isOpen : undefined}
            tabIndex={0}
            draggable={canEdit}
            onClick={() => onOpen(node)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onOpen(node);
              }
            }}
            onDragStart={(event) => {
              onDragPath(node.path);
              event.dataTransfer.setData("text/plain", node.path);
              event.dataTransfer.effectAllowed = "move";
            }}
            onDragEnd={() => onDragPath(null)}
            onDragOver={(event) => {
              if (node.kind !== "dir" || !dragPath) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
            }}
            onDrop={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (node.kind !== "dir") {
                onDragPath(null);
                return;
              }
              const from = event.dataTransfer.getData("text/plain") || dragPath;
              if (from) onMove(from, node.path);
              onDragPath(null);
            }}
            style={{ paddingLeft: `${depth * 12 + 8}px` }}
            className={cn(
              "group flex h-7 cursor-pointer select-none items-center gap-1.5 rounded pr-1.5 text-xs transition-colors",
              active
                ? "bg-primary/15 text-primary"
                : "text-foreground/90 hover:bg-muted",
              dragPath === node.path && "opacity-50",
            )}
          >
            <span className="flex h-3.5 w-3.5 items-center justify-center text-muted-foreground">
              {node.kind === "dir" ? (
                isOpen ? (
                  <ChevronDown className="h-3 w-3" />
                ) : (
                  <ChevronRight className="h-3 w-3" />
                )
              ) : null}
            </span>
            <EntryIcon path={node.path} kind={node.kind} open={isOpen} />
            <span className="truncate">{node.name}</span>
            {node.meta?.size ? (
              <span className="ml-auto hidden text-[9px] text-muted-foreground group-hover:inline">
                {node.meta.size > 1024
                  ? `${Math.round(node.meta.size / 1024)}k`
                  : `${node.meta.size}b`}
              </span>
            ) : null}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {canEdit && node.kind === "dir" ? (
            <>
              <ContextMenuItem
                onSelect={() => onStartDialog("create-file", node.path)}
              >
                <Plus /> New file
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() => onStartDialog("create-dir", node.path)}
              >
                <FolderPlus /> New folder
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>
          ) : null}
          {canEdit ? (
            <>
              <ContextMenuItem
                onSelect={() => onStartDialog("rename", node.path)}
              >
                Rename…
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() => onRemove(node)}
                className="text-destructive"
              >
                <Trash2 /> Delete
              </ContextMenuItem>
              {node.kind === "dir" ? <ContextMenuSeparator /> : null}
            </>
          ) : null}
          <ContextMenuItem
            onSelect={() => {
              void navigator.clipboard.writeText(node.path);
              toast.success("Path copied");
            }}
          >
            Copy path
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {node.kind === "dir" && isOpen
        ? node.children.map((child) => (
            <FileTreeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              activeFileId={activeFileId}
              expanded={expanded}
              dragPath={dragPath}
              canEdit={canEdit}
              onOpen={onOpen}
              onStartDialog={onStartDialog}
              onRemove={onRemove}
              onDragPath={onDragPath}
              onMove={onMove}
            />
          ))
        : null}
    </div>
  );
}
