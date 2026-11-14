"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Copy, X } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSession } from "@/components/providers/session-provider";
import { encodeStateVector, getClientDoc } from "@/lib/yjs/client";
import { cn } from "@/lib/utils";
import { useWorkspaceStore, type OpenTab } from "@/stores/workspace.store";

const TAB_WIDTH = 156;

function fileGlyph(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(extension)) return "TS";
  if (["py"].includes(extension)) return "PY";
  if (["html", "htm"].includes(extension)) return "<>";
  if (["css", "scss", "less"].includes(extension)) return "#";
  if (["json", "jsonc"].includes(extension)) return "{}";
  if (["md", "mdx"].includes(extension)) return "M";
  if (["yml", "yaml"].includes(extension)) return "Y";
  if (["sh", "bash", "zsh"].includes(extension)) return "$";
  return "•";
}

function TabContents({ tab }: { tab: OpenTab }) {
  const name = tab.path.split("/").pop() ?? tab.path;
  return (
    <>
      <span className="font-mono text-[9px] font-bold text-primary/80">
        {fileGlyph(tab.path)}
      </span>
      <span className="truncate">{name}</span>
    </>
  );
}

export function TabBar() {
  const { send } = useSession();
  const tabs = useWorkspaceStore((state) => state.tabs);
  const activeFileId = useWorkspaceStore((state) => state.activeFileId);
  const setActive = useWorkspaceStore((state) => state.setActive);
  const closeTab = useWorkspaceStore((state) => state.closeTab);
  const closeOtherTabs = useWorkspaceStore((state) => state.closeOtherTabs);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [availableWidth, setAvailableWidth] = useState(0);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const update = (): void => setAvailableWidth(element.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Flex layout can settle after the first effect (for example while the
  // people rail or file tree mounts). Re-measure before paint so the overflow
  // menu never waits for a resize that may never happen.
  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    setAvailableWidth(element.clientWidth);
    const frame = window.requestAnimationFrame(() => {
      setAvailableWidth(element.clientWidth);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [tabs.length, activeFileId]);

  const visibleCount = useMemo(() => {
    if (availableWidth <= 0 || tabs.length === 0) return tabs.length;
    const dropdownSpace = tabs.length > 1 ? 36 : 0;
    return Math.max(
      1,
      Math.min(
        tabs.length,
        Math.floor((availableWidth - dropdownSpace) / TAB_WIDTH),
      ),
    );
  }, [availableWidth, tabs.length]);

  const visibleTabs = useMemo(() => {
    if (tabs.length <= visibleCount) return tabs;
    const activeIndex = tabs.findIndex((tab) => tab.fileId === activeFileId);
    if (activeIndex < visibleCount) return tabs.slice(0, visibleCount);
    return [...tabs.slice(0, visibleCount - 1), tabs[activeIndex]];
  }, [activeFileId, tabs, visibleCount]);

  const visibleIds = new Set(visibleTabs.map((tab) => tab.fileId));
  const overflowTabs = tabs.filter((tab) => !visibleIds.has(tab.fileId));

  const activate = (fileId: string, path: string): void => {
    if (fileId === activeFileId) return;
    setActive(fileId);
    const doc = getClientDoc(fileId);
    if (doc) {
      send("yjs_sync_request", { fileId, stateVector: encodeStateVector(doc) });
    } else {
      send("file_op", { op: "open", fileId, path });
    }
  };

  if (tabs.length === 0) return null;

  return (
    <div
      ref={containerRef}
      role="tablist"
      aria-label="Open files"
      className="scrollbar-thin flex h-10 shrink-0 items-stretch overflow-hidden border-b border-border bg-muted/25"
    >
      {visibleTabs.map((tab) => {
        const active = tab.fileId === activeFileId;
        const name = tab.path.split("/").pop() ?? tab.path;
        return (
          <ContextMenu key={tab.fileId}>
            <ContextMenuTrigger asChild>
              <div
                className={cn(
                  "group flex min-w-0 shrink-0 items-center border-r border-border transition-colors",
                  active
                    ? "bg-primary/15 text-primary shadow-[inset_0_2px_0_hsl(var(--primary))]"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={active}
                  title={tab.path}
                  onClick={() => activate(tab.fileId, tab.path)}
                  onAuxClick={(event) => {
                    if (event.button === 1) closeTab(tab.fileId);
                  }}
                  className="flex h-full min-w-0 max-w-[200px] items-center gap-2 px-3 text-xs outline-none focus-visible:ring-0"
                >
                  <TabContents tab={tab} />
                </button>
                <button
                  type="button"
                  aria-label={`Close ${name}`}
                  onClick={() => closeTab(tab.fileId)}
                  className="mr-1 rounded p-1 opacity-0 transition-opacity hover:bg-accent focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onSelect={() => closeTab(tab.fileId)}>
                Close
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => closeOtherTabs(tab.fileId)}>
                Close others
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem
                onSelect={() => {
                  void navigator.clipboard.writeText(tab.path);
                }}
              >
                Copy path
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        );
      })}

      {overflowTabs.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`Show ${overflowTabs.length} more open files`}
              className="ml-auto flex h-full shrink-0 items-center gap-1 border-l border-border bg-card/80 px-3 text-[11px] font-medium text-foreground/80 shadow-[-8px_0_12px_-12px_rgba(0,0,0,0.9)] transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-0"
            >
              <span className="max-w-20 truncate">
                +{overflowTabs.length} more
              </span>
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-72">
            <DropdownMenuLabel>More open files</DropdownMenuLabel>
            {overflowTabs.map((tab) => (
              <DropdownMenuSub key={tab.fileId}>
                <DropdownMenuSubTrigger className="min-w-0 justify-between">
                  <span className="min-w-0 truncate">{tab.path}</span>
                  {tab.fileId === activeFileId ? (
                    <span className="text-[9px] text-primary">active</span>
                  ) : null}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuItem
                    onSelect={() => activate(tab.fileId, tab.path)}
                  >
                    Open file
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => closeTab(tab.fileId)}>
                    Close
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => closeOtherTabs(tab.fileId)}>
                    Close others
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onSelect={() => {
                      void navigator.clipboard.writeText(tab.path);
                    }}
                  >
                    <Copy /> Copy path
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}
