"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Hand,
  Mic,
  MicOff,
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
import { RemoteAudio, VideoTile } from "./video/VideoTile";

interface VideoDockProps {
  webrtc: WebRtcApi;
}

/**
 * Media strip below the editor. The WebRTC hook is owned by RoomShell so the
 * hotkeys and the dock share one media/peer-mesh instance.
 */
export function VideoDock({ webrtc }: VideoDockProps) {
  const router = useRouter();
  const { send, disconnect } = useSession();
  const [confirmLeave, setConfirmLeave] = useState(false);
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

      {anyVideo ? (
        <div className="scrollbar-thin flex gap-2 overflow-x-auto px-2 pt-2">
          <VideoTile
            name={self?.name ?? "You"}
            color={self?.color ?? "#4ea1ff"}
            stream={localPreview}
            isSelf
            micOn={micEnabled}
            screenSharing={screenSharing}
            camOff={!camEnabled && !screenSharing}
          />
          {videoRemotes.map((participant) => (
            <VideoTile
              key={participant.id}
              name={participant.name}
              color={participant.color}
              stream={remoteStreams[participant.id] ?? null}
              isSelf={false}
              micOn={participant.mic}
              screenSharing={participant.screen}
              camOff={!participant.cam && !participant.screen}
            />
          ))}
        </div>
      ) : null}

      <div className="flex h-11 items-center gap-1 px-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant={micEnabled ? "secondary" : "ghost"}
              size="icon-sm"
              className={cn("h-8 w-8", micEnabled && "text-emerald-400")}
              onClick={toggleMic}
              aria-label={micEnabled ? "Mute microphone" : "Unmute microphone"}
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
                !canShareScreen && "opacity-40",
              )}
              onClick={() => void toggleScreen()}
              disabled={!canShareScreen}
              aria-label={
                canShareScreen
                  ? "Share screen"
                  : "Screen sharing is not allowed"
              }
            >
              <MonitorUp className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {canShareScreen
              ? screenSharing
                ? "Stop sharing"
                : "Share your screen"
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
