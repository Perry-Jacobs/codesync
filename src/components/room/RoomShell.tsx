"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  Clock,
  DoorOpen,
  Loader2,
  Lock,
  WifiOff,
} from "lucide-react";

import { useSession } from "@/components/providers/session-provider";
import { EditorPane } from "@/components/editor/EditorPane";
import { TabBar } from "@/components/editor/TabBar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { FileTree } from "@/components/room/FileTree";
import { MediaGallery } from "@/components/room/MediaGallery";
import { ResizableSidePanel } from "@/components/room/ResizableSidePanel";
import { SidePanel } from "@/components/room/SidePanel";
import { TopBar } from "@/components/room/TopBar";
import { VideoDock } from "@/components/room/VideoDock";
import { WaitingRoomSheet } from "@/components/room/WaitingRoomSheet";
import { useHostWorkspace } from "@/hooks/useHostWorkspace";
import { useRoomHotkeys } from "@/hooks/useRoomHotkeys";
import { useWebRTC } from "@/hooks/useWebRTC";

import { cn } from "@/lib/utils";
import { useRoomStore } from "@/stores/room.store";
import { useUiStore } from "@/stores/ui.store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout.store";
import { useWorkspaceStore } from "@/stores/workspace.store";

export function RoomShell({ roomKey }: { roomKey: string }) {
  const router = useRouter();
  const { send, disconnect } = useSession();
  const room = useRoomStore((state) => state.room);
  const self = useRoomStore((state) => state.self);
  const status = useRoomStore((state) => state.status);
  const connection = useRoomStore((state) => state.connection);
  const error = useRoomStore((state) => state.error);
  const files = useWorkspaceStore((state) => state.files);
  const openFile = useWorkspaceStore((state) => state.openFile);
  const sidebarOpen = useUiStore((state) => state.sidebarOpen);
  const railOpen = useUiStore((state) => state.railOpen);
  const setSidebarOpen = useUiStore((state) => state.setSidebarOpen);
  const setRailOpen = useUiStore((state) => state.setRailOpen);
  const setSidePanelTab = useUiStore((state) => state.setSidePanelTab);
  const mediaFullscreen = useUiStore((state) => state.mediaFullscreen);

  const workspaceRevision = useWorkspaceStore((state) => state.revision);
  const sidebarWidth = useWorkspaceLayoutStore((state) => state.sidebarWidth);
  const railWidth = useWorkspaceLayoutStore((state) => state.railWidth);
  const setSidebarWidth = useWorkspaceLayoutStore(
    (state) => state.setSidebarWidth,
  );
  const setRailWidth = useWorkspaceLayoutStore((state) => state.setRailWidth);

  const host = useHostWorkspace(roomKey);
  const webrtc = useWebRTC();
  useRoomHotkeys({ host });

  const [waitingOpen, setWaitingOpen] = useState(false);
  const [mobileFiles, setMobileFiles] = useState(false);
  const [mobileRail, setMobileRail] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(1280);
  const openedInitialFile = useRef(false);
  const wasScreenSharing = useRef(false);
  const isDesktopRail = viewportWidth >= 1024;
  const someoneIsScreenSharing = useRoomStore((state) =>
    state.participants.some((participant) => participant.screen),
  );

  useEffect(() => {
    void useWorkspaceLayoutStore.persist.rehydrate();
    useUiStore.getState().setMediaFullscreen(false);

    const updateViewportWidth = (): void => setViewportWidth(window.innerWidth);
    updateViewportWidth();
    window.addEventListener("resize", updateViewportWidth);
    return () => {
      window.removeEventListener("resize", updateViewportWidth);
      useUiStore.getState().setMediaFullscreen(false);
    };
  }, []);

  useEffect(() => {
    if (isDesktopRail) setMobileRail(false);
  }, [isDesktopRail]);

  // Track whether the rail is genuinely on screen. The chat unread badge uses
  // this instead of `railOpen`, which stays true behind a closed compact
  // drawer and would otherwise swallow messages that arrive while it hides.
  useEffect(() => {
    useUiStore.getState().setRailVisible(isDesktopRail ? railOpen : mobileRail);
  }, [isDesktopRail, mobileRail, railOpen]);

  // The compact explorer is a drawer over the editor. Dismiss it as soon as a
  // file is picked, on Escape, or when the full sidebar becomes available.
  useEffect(() => {
    if (!mobileFiles) return;
    const dismiss = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setMobileFiles(false);
    };
    document.addEventListener("keydown", dismiss, true);
    return () => document.removeEventListener("keydown", dismiss, true);
  }, [mobileFiles]);

  useEffect(() => {
    if (viewportWidth >= 768) setMobileFiles(false);
  }, [viewportWidth]);

  useEffect(() => {
    if (someoneIsScreenSharing && !wasScreenSharing.current) {
      setSidePanelTab("gallery");
      if (isDesktopRail) setRailOpen(true);
      else setMobileRail(true);
    }
    wasScreenSharing.current = someoneIsScreenSharing;
  }, [isDesktopRail, setRailOpen, setSidePanelTab, someoneIsScreenSharing]);

  // Attaching, detaching or reloading a host folder replaces the workspace;
  // open the first file of the new tree so nobody is left on a blank editor.
  useEffect(() => {
    openedInitialFile.current = false;
  }, [workspaceRevision]);

  // Open the first file once the workspace arrives so the editor is never empty.
  // Read-only participants follow the same file; the editor stays read-only.
  useEffect(() => {
    if (status !== "admitted" || openedInitialFile.current) return;
    const first = files.find((file) => file.kind === "file");
    if (!first) return;
    openedInitialFile.current = true;
    openFile({ fileId: first.fileId, path: first.path });
    send("file_op", { op: "open", fileId: first.fileId, path: first.path });
  }, [files, openFile, send, status]);

  const toggleFiles = (): void => {
    if (window.matchMedia("(max-width: 767px)").matches) {
      setMobileFiles(true);
      return;
    }
    setSidebarOpen(!sidebarOpen);
  };

  const togglePeople = (): void => {
    if (window.matchMedia("(max-width: 1023px)").matches) {
      setMobileRail(true);
      return;
    }
    setRailOpen(!railOpen);
  };

  const leave = (): void => {
    send("leave_room", { reason: "left the session" });
    disconnect();
    router.push("/");
  };

  if (status === "waiting") {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-6 text-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/15 text-primary">
          <Clock className="h-6 w-6 animate-pulse" />
        </span>
        <h1 className="text-xl font-semibold">Waiting for the host</h1>
        <p className="max-w-sm text-sm text-muted-foreground">
          {room?.title ? `${room.title} · ` : ""}
          The host has to admit you before the workspace appears.
        </p>
        <Badge variant="warning" className="gap-1">
          <Lock className="h-3 w-3" /> {roomKey}
        </Badge>
        <Button variant="outline" onClick={leave}>
          Leave the waiting room
        </Button>
      </main>
    );
  }

  if (
    status === "denied" ||
    status === "kicked" ||
    status === "ended" ||
    status === "error"
  ) {
    const message =
      error ??
      (status === "denied"
        ? "The host denied your request to join"
        : status === "kicked"
          ? "The host removed you from the session"
          : status === "ended"
            ? "The host ended this session"
            : "The session is not available");
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-6 text-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
          {status === "ended" ? (
            <DoorOpen className="h-6 w-6" />
          ) : (
            <WifiOff className="h-6 w-6" />
          )}
        </span>
        <h1 className="text-xl font-semibold">This session is closed</h1>
        <p className="max-w-md text-sm text-muted-foreground">{message}</p>
        <Button asChild variant="outline">
          <Link href="/">
            <ArrowLeft className="h-4 w-4" /> Back to home
          </Link>
        </Button>
      </main>
    );
  }

  if (status !== "admitted" || !self) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-3 bg-card text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
        <p className="text-sm">Joining the session…</p>
      </main>
    );
  }

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden bg-background p-0 text-foreground sm:p-1 lg:p-2">
      <div className="flex min-h-0 w-full flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl sm:rounded-2xl">
        <TopBar
          roomKey={roomKey}
          host={host}
          onToggleSidebar={toggleFiles}
          onTogglePeople={togglePeople}
        />

        {connection !== "open" ? (
          <div className="flex h-7 shrink-0 items-center justify-center gap-2 border-b border-border bg-amber-500/10 text-[11px] text-amber-500">
            <Loader2 className="h-3 w-3 animate-spin" />
            {connection === "closed"
              ? "Connection lost — reconnecting…"
              : "Reconnecting…"}
          </div>
        ) : null}

        <div className="flex min-h-0 flex-1">
          {sidebarOpen ? (
            <ResizableSidePanel
              side="left"
              width={sidebarWidth}
              minWidth={160}
              maxWidth={Math.min(
                420,
                Math.max(
                  160,
                  viewportWidth -
                    (viewportWidth >= 1024 && railOpen ? railWidth : 0) -
                    360,
                ),
              )}
              onWidthChange={setSidebarWidth}
              className="hidden md:flex"
            >
              <FileTree host={host} />
            </ResizableSidePanel>
          ) : null}

          <main className="flex min-w-0 flex-1 flex-col">
            <TabBar />
            <div className="min-h-0 flex-1">
              <EditorPane />
            </div>
            <VideoDock
              webrtc={webrtc}
              galleryVisible={isDesktopRail ? railOpen : mobileRail}
            />
          </main>

          {isDesktopRail && railOpen ? (
            <ResizableSidePanel
              side="right"
              width={railWidth}
              minWidth={280}
              maxWidth={Math.min(
                520,
                Math.max(
                  280,
                  viewportWidth -
                    (viewportWidth >= 768 && sidebarOpen ? sidebarWidth : 0) -
                    250,
                ),
              )}
              onWidthChange={setRailWidth}
              className="flex"
            >
              <SidePanel onOpenWaiting={() => setWaitingOpen(true)} />
            </ResizableSidePanel>
          ) : null}
        </div>
      </div>

      <Sheet open={mobileFiles} onOpenChange={setMobileFiles}>
        <SheetContent side="left" className="w-[min(18rem,100vw)] p-0">
          <SheetHeader className="sr-only">
            <SheetTitle>Workspace files</SheetTitle>
            <SheetDescription>Files in this session</SheetDescription>
          </SheetHeader>
          <FileTree host={host} onFileOpen={() => setMobileFiles(false)} />
        </SheetContent>
      </Sheet>

      {!isDesktopRail ? (
        <Sheet open={mobileRail} onOpenChange={setMobileRail}>
          <SheetContent
            side="right"
            className="w-[min(22rem,calc(100vw-1rem))] max-w-[calc(100vw-1rem)] rounded-l-2xl border-l bg-card/95 p-0 shadow-2xl backdrop-blur-xl sm:w-80 sm:max-w-80"
          >
            <SheetHeader className="sr-only">
              <SheetTitle>People and chat</SheetTitle>
              <SheetDescription>
                Session participants and messages
              </SheetDescription>
            </SheetHeader>
            <div className={cn("h-full min-h-0 overflow-hidden")}>
              <SidePanel
                variant="drawer"
                onOpenWaiting={() => setWaitingOpen(true)}
              />
            </div>
          </SheetContent>
        </Sheet>
      ) : null}

      <WaitingRoomSheet open={waitingOpen} onOpenChange={setWaitingOpen} />
      {mediaFullscreen ? <MediaGallery fullscreen /> : null}
    </div>
  );
}
