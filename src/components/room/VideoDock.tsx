"use client";

import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useRouter } from "next/navigation";
import {
  Hand,
  Maximize2,
  Mic,
  MicOff,
  Minimize2,
  MonitorUp,
  PhoneOff,
  Video,
  VideoOff,
} from "lucide-react";

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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { WebRtcApi } from "@/hooks/useWebRTC";
import { cn } from "@/lib/utils";
import { useMediaStore } from "@/stores/media.store";
import { useRoomStore } from "@/stores/room.store";
import { useUiStore } from "@/stores/ui.store";
import { RemoteAudio, VideoTile } from "./video/VideoTile";

interface VideoDockProps {
  webrtc: WebRtcApi;
  galleryVisible: boolean;
}

interface VideoDockDragState {
  pointerId: number;
  startY: number;
  startHeight: number;
}

const MIN_VIDEO_HEIGHT = 112;
const MAX_VIDEO_HEIGHT = 720;
const DEFAULT_VIDEO_HEIGHT = 184;
const VIDEO_HEIGHT_STORAGE_KEY = "codesync:video-dock-height";

/**
 * Media strip below the editor. The WebRTC hook is owned by RoomShell so the
 * hotkeys and the dock share one media/peer-mesh instance.
 */
export function VideoDock({ webrtc, galleryVisible }: VideoDockProps) {
  const router = useRouter();
  const { send, disconnect } = useSession();
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [videoHeight, setVideoHeight] = useState(DEFAULT_VIDEO_HEIGHT);
  const setSidePanelTab = useUiStore((state) => state.setSidePanelTab);
  const sidePanelTab = useUiStore((state) => state.sidePanelTab);
  const isFullscreen = useUiStore((state) => state.mediaFullscreen);
  const setMediaFullscreen = useUiStore((state) => state.setMediaFullscreen);
  const [dragging, setDragging] = useState(false);
  const dragState = useRef<VideoDockDragState | null>(null);
  const self = useRoomStore((state) => state.self);
  const participants = useRoomStore((state) => state.participants);
  const remoteStreams = useMediaStore((state) => state.remoteStreams);
  const screenStream = useMediaStore((state) => state.screenStream);
  const {
    localStream,
    micEnabled,
    camEnabled,
    screenSharing,
    canShareScreen,
    permissionError,
    speakRequested,
    toggleMic,
    toggleCam,
    toggleScreen,
  } = webrtc;

  const remotes = participants.filter(
    (participant) => participant.id !== self?.id,
  );
  const hasLiveVideo = (stream: MediaStream | null | undefined): boolean =>
    Boolean(
      stream
        ?.getVideoTracks()
        .some((track) => track.readyState === "live" && !track.muted),
    );
  const videoRemotes = remotes.filter((participant) =>
    hasLiveVideo(remoteStreams[participant.id]),
  );
  const localPreview = screenSharing ? screenStream : localStream;
  const anyVideo = hasLiveVideo(localPreview) || videoRemotes.length > 0;
  const sharedRemotes = videoRemotes.filter(
    (participant) => participant.screen,
  );
  const localIsShared = screenSharing && hasLiveVideo(screenStream);

  useEffect(() => {
    const stored = Number(
      window.localStorage.getItem(VIDEO_HEIGHT_STORAGE_KEY),
    );
    if (Number.isFinite(stored) && stored >= MIN_VIDEO_HEIGHT) {
      setVideoHeight(Math.min(stored, MAX_VIDEO_HEIGHT));
    }
  }, []);

  useEffect(() => {
    if (!dragging) return;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
    };
  }, [dragging]);

  const clampVideoHeight = (height: number): number =>
    Math.min(Math.max(height, MIN_VIDEO_HEIGHT), MAX_VIDEO_HEIGHT);

  const updateVideoHeight = (height: number): void => {
    const nextHeight = clampVideoHeight(height);
    setVideoHeight(nextHeight);
    window.localStorage.setItem(VIDEO_HEIGHT_STORAGE_KEY, String(nextHeight));
  };

  const toggleFullscreen = (): void => {
    if (isFullscreen) {
      setMediaFullscreen(false);
      return;
    }

    setSidePanelTab("gallery");
    setMediaFullscreen(true);
  };

  const handleResizeStart = (
    event: ReactPointerEvent<HTMLButtonElement>,
  ): void => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragState.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: videoHeight,
    };
    setDragging(true);
  };

  const handleResizeMove = (
    event: ReactPointerEvent<HTMLButtonElement>,
  ): void => {
    const state = dragState.current;
    if (!state || state.pointerId !== event.pointerId) return;
    updateVideoHeight(state.startHeight + state.startY - event.clientY);
  };

  const finishResize = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (dragState.current?.pointerId !== event.pointerId) return;
    dragState.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleResizeKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
  ): void => {
    const step = event.shiftKey ? 40 : 12;
    if (event.key === "ArrowUp") {
      updateVideoHeight(videoHeight + step);
    } else if (event.key === "ArrowDown") {
      updateVideoHeight(videoHeight - step);
    } else if (event.key === "Home") {
      updateVideoHeight(MIN_VIDEO_HEIGHT);
    } else if (event.key === "End") {
      updateVideoHeight(MAX_VIDEO_HEIGHT);
    } else if (event.key === "Enter" || event.key === " ") {
      updateVideoHeight(DEFAULT_VIDEO_HEIGHT);
    } else {
      return;
    }
    event.preventDefault();
  };

  const leave = (): void => {
    send("leave_room", { reason: "left the session" });
    disconnect();
    router.push("/");
  };

  return (
    <div className="shrink-0 border-t border-border bg-card">
      {remotes.map((participant) => {
        const stream = remoteStreams[participant.id];
        return stream ? (
          <RemoteAudio key={`audio-${participant.id}`} stream={stream} />
        ) : null;
      })}

      {!isFullscreen &&
      !(galleryVisible && sidePanelTab === "gallery") &&
      anyVideo ? (
        <div
          className="relative min-h-0 border-b border-border/60 bg-black/10"
          style={{ height: videoHeight, maxHeight: "75dvh" }}
        >
          <button
            type="button"
            role="separator"
            aria-label="Resize video area"
            aria-orientation="horizontal"
            aria-valuemin={MIN_VIDEO_HEIGHT}
            aria-valuemax={MAX_VIDEO_HEIGHT}
            aria-valuenow={Math.round(videoHeight)}
            title="Drag to resize · arrow keys for precise sizing · double-click to reset"

            className={cn(
              "group absolute inset-x-0 -top-1 z-20 h-2 cursor-row-resize touch-none outline-none",
              dragging && "cursor-row-resize",
            )}
            onPointerDown={handleResizeStart}
            onPointerMove={handleResizeMove}
            onPointerUp={finishResize}
            onPointerCancel={finishResize}
            onDoubleClick={() => updateVideoHeight(DEFAULT_VIDEO_HEIGHT)}
            onKeyDown={handleResizeKeyDown}
          >
            <span
              className={cn(
                "absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border transition-[background-color,box-shadow] duration-150",
                "group-hover:bg-primary group-hover:shadow-[0_0_8px_hsl(var(--primary)/0.45)]",
                "group-focus-visible:bg-primary group-focus-visible:shadow-[0_0_8px_hsl(var(--primary)/0.65)]",
                dragging &&
                  "bg-primary shadow-[0_0_10px_hsl(var(--primary)/0.65)]",
              )}
            />
          </button>

          <div
            className={cn(
              "scrollbar-thin flex h-full gap-3 overflow-x-auto overflow-y-hidden px-3 py-3",
            )}
          >
            {localIsShared ? (
              <VideoTile
                name={`${self?.name ?? "You"} — screen`}
                color={self?.color ?? "#4ea1ff"}
                stream={screenStream}
                isSelf
                micOn={micEnabled}
                screenSharing
                className={cn(
                  isFullscreen
                    ? "aspect-video w-full min-w-0"
                    : "h-full w-auto min-w-[220px] max-w-[420px]",
                )}
              />
            ) : null}
            {sharedRemotes.map((participant) => (
              <VideoTile
                key={`shared-${participant.id}`}
                name={`${participant.name} — screen`}
                color={participant.color}
                stream={remoteStreams[participant.id] ?? null}
                isSelf={false}
                micOn={participant.mic}
                screenSharing
                className={cn(
                  isFullscreen
                    ? "aspect-video w-full min-w-0"
                    : "h-full w-auto min-w-[220px] max-w-[420px]",
                )}
              />
            ))}
            {!localIsShared ? (
              <VideoTile
                name={self?.name ?? "You"}
                color={self?.color ?? "#4ea1ff"}
                stream={localPreview}
                isSelf
                micOn={micEnabled}
                screenSharing={screenSharing}
                camOff={!camEnabled && !screenSharing}
                className={cn(isFullscreen && "aspect-video w-full min-w-0")}
              />
            ) : null}
            {videoRemotes
              .filter((participant) => !participant.screen)
              .map((participant) => (
                <VideoTile
                  key={participant.id}
                  name={participant.name}
                  color={participant.color}
                  stream={remoteStreams[participant.id] ?? null}
                  isSelf={false}
                  micOn={participant.mic}
                  camOff={!participant.cam}
                  className={cn(isFullscreen && "aspect-video w-full min-w-0")}
                />
              ))}
          </div>
        </div>
      ) : null}

      <div className="flex h-11 items-center gap-1 px-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant={micEnabled ? "secondary" : "ghost"}
              size="icon-sm"
              className={cn(
                "h-8 w-8",
                micEnabled && "text-emerald-400",
                speakRequested &&
                  !self?.canSpeak &&
                  "animate-pulse text-amber-400",
              )}
              onClick={toggleMic}
              aria-label={
                speakRequested && !self?.canSpeak
                  ? "Waiting for speak access"
                  : micEnabled
                    ? "Mute microphone"
                    : "Unmute microphone"
              }
            >
              {micEnabled ? (
                <Mic className="h-4 w-4" />
              ) : (
                <MicOff className="h-4 w-4" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {self?.canSpeak
              ? micEnabled
                ? "Mute (hold Space to talk)"
                : "Unmute (hold Space to talk)"
              : speakRequested
                ? "Waiting for the host to grant speak access"
                : "Ask the host for speak access"}
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant={camEnabled ? "secondary" : "ghost"}
              size="icon-sm"
              className={cn("h-8 w-8", camEnabled && "text-sky-400")}
              onClick={toggleCam}
              aria-label={camEnabled ? "Turn camera off" : "Turn camera on"}
            >
              {camEnabled ? (
                <Video className="h-4 w-4" />
              ) : (
                <VideoOff className="h-4 w-4" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {camEnabled ? "Turn camera off" : "Turn camera on"}
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant={screenSharing ? "secondary" : "ghost"}
              size="icon-sm"
              className={cn(
                "h-8 w-8",
                screenSharing && "text-violet-400",
                !canShareScreen && !screenSharing && "opacity-40",
              )}
              onClick={() => void toggleScreen()}
              disabled={!canShareScreen && !screenSharing}
              aria-label={
                screenSharing
                  ? "Stop sharing"
                  : canShareScreen
                    ? "Share screen"
                    : "Screen sharing is not allowed"
              }
            >
              <MonitorUp className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {screenSharing
              ? "Stop sharing"
              : canShareScreen
                ? "Share your screen"
                : "Only the host and co-hosts can share"}
          </TooltipContent>
        </Tooltip>

        {self && !self.canSpeak ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-pressed={self.handRaised}
                className={cn(
                  "h-8 w-8",
                  self.handRaised &&
                    "bg-amber-500/15 text-amber-600 hover:bg-amber-500/25 hover:text-amber-500 dark:text-amber-300 dark:hover:text-amber-200",
                )}
                onClick={() => send("raise_hand", { raised: !self.handRaised })}
                aria-label={self.handRaised ? "Lower hand" : "Raise hand"}
              >
                <Hand className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {self.handRaised ? "Lower hand" : "Raise hand"}
            </TooltipContent>
          </Tooltip>
        ) : null}

        {permissionError ? (
          <span
            className="ml-2 min-w-0 flex-1 truncate text-[10px] text-rose-400"
            role="status"
          >
            {permissionError}
          </span>
        ) : (
          <span className="ml-2 hidden text-[10px] text-muted-foreground sm:inline">
            {remotes.length === 0
              ? "You are the only one here"
              : `${remotes.length} ${remotes.length === 1 ? "peer" : "peers"} connected`}
          </span>
        )}

        <div className="ml-auto flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="h-8 w-8"
                onClick={() => void toggleFullscreen()}
                disabled={!anyVideo}
                aria-label={
                  isFullscreen ? "Exit fullscreen" : "View media fullscreen"
                }
              >
                {isFullscreen ? (
                  <Minimize2 className="h-4 w-4" />
                ) : (
                  <Maximize2 className="h-4 w-4" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {isFullscreen
                ? "Exit fullscreen"
                : anyVideo
                  ? "View cameras and screens fullscreen"
                  : "Turn on a camera or share a screen first"}
            </TooltipContent>
          </Tooltip>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5 text-[11px] text-rose-400 hover:bg-rose-500/10 hover:text-rose-300"
            onClick={() => setConfirmLeave(true)}
          >
            <PhoneOff className="h-4 w-4" /> Leave
          </Button>
        </div>
      </div>

      <Dialog open={confirmLeave} onOpenChange={setConfirmLeave}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <PhoneOff className="h-4 w-4 text-rose-400" /> Leave this session?
            </DialogTitle>
            <DialogDescription>
              {self?.role === "HOST"
                ? "The room stays open, but your local folder stops syncing and live edits pause while you are away."
                : "You will leave the participant list and stop receiving live edits."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmLeave(false)}>
              Stay
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmLeave(false);
                leave();
              }}
            >
              <PhoneOff className="h-4 w-4" /> Leave session
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
