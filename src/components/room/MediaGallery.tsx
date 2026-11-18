"use client";

import { useEffect } from "react";
import { Minimize2, MonitorUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { VideoTile } from "@/components/room/video/VideoTile";
import { useMediaStore } from "@/stores/media.store";
import { useRoomStore } from "@/stores/room.store";
import { useUiStore } from "@/stores/ui.store";
import { cn } from "@/lib/utils";

export function MediaGallery({ fullscreen = false }: { fullscreen?: boolean }) {
  const setMediaFullscreen = useUiStore((state) => state.setMediaFullscreen);
  const self = useRoomStore((state) => state.self);
  const participants = useRoomStore((state) => state.participants);
  const remoteStreams = useMediaStore((state) => state.remoteStreams);
  const localStream = useMediaStore((state) => state.localStream);
  const screenStream = useMediaStore((state) => state.screenStream);
  const camEnabled = useMediaStore((state) => state.camEnabled);
  const screenSharing = useMediaStore((state) => state.screenSharing);
  const micEnabled = useMediaStore((state) => state.micEnabled);

  useEffect(() => {
    if (!fullscreen) return;
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setMediaFullscreen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [fullscreen, setMediaFullscreen]);

  const remotes = participants.filter(
    (participant) => participant.id !== self?.id,
  );
  const localIsSharing = screenSharing && Boolean(screenStream);
  const sharedParticipants = remotes.filter(
    (participant) => participant.screen,
  );
  const cameraParticipants = remotes.filter(
    (participant) => !participant.screen,
  );
  const tileCount =
    sharedParticipants.length +
    (localIsSharing ? 1 : 0) +
    (self && !localIsSharing ? 1 : 0) +
    cameraParticipants.length;
  // Fullscreen uses the whole viewport: pick roughly square columns and let
  // every row share the remaining height instead of stacking fixed 16:9 tiles
  // at the top with empty space below.
  const fullscreenColumns = Math.max(
    1,
    Math.ceil(Math.sqrt(Math.max(1, tileCount))),
  );
  const tileClass = fullscreen
    ? "aspect-auto h-full min-h-0 w-full min-w-0"
    : "";

  return (
    <section
      className={
        fullscreen
          ? "fixed inset-0 z-[100] flex min-h-0 flex-col bg-background"
          : "flex min-h-0 flex-1 flex-col"
      }
      aria-label={fullscreen ? "Fullscreen media gallery" : "Media gallery"}
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <MonitorUp className="h-4 w-4 text-muted-foreground" />
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Media gallery
        </span>
        <span className="ml-auto text-xs text-muted-foreground">
          {participants.length}{" "}
          {participants.length === 1 ? "person" : "people"}
        </span>
        {fullscreen ? (
          <Button
            variant="ghost"
            size="icon-sm"
            className="h-8 w-8"
            onClick={() => setMediaFullscreen(false)}
            aria-label="Exit fullscreen gallery"
          >
            <Minimize2 className="h-4 w-4" />
          </Button>
        ) : null}
      </header>

      <div
        className={cn(
          "min-h-0 flex-1 p-2 sm:p-3",
          fullscreen
            ? "grid overflow-hidden"
            : "scrollbar-thin overflow-y-auto",
        )}
        style={
          fullscreen
            ? {
                gridTemplateColumns: `repeat(${fullscreenColumns}, minmax(0, 1fr))`,
                gridAutoRows: "minmax(0, 1fr)",
                gap: "0.75rem",
              }
            : {
                display: "grid",
                gridTemplateColumns:
                  "repeat(auto-fit, minmax(min(100%, 280px), 1fr))",
                gridAutoRows: "max-content",
                alignContent: "start",
                gap: "0.75rem",
              }
        }
      >
        {sharedParticipants.map((participant) => (
          <VideoTile
            key={`screen-${participant.id}`}
            name={`${participant.name} — shared screen`}
            color={participant.color}
            stream={remoteStreams[participant.id] ?? null}
            isSelf={false}
            micOn={participant.mic}
            screenSharing
            fullscreenable
            className={
              fullscreen
                ? tileClass
                : "col-span-full aspect-video w-full min-w-0 md:aspect-[16/8]"
            }
          />
        ))}
        {localIsSharing ? (
          <VideoTile
            name={`${self?.name ?? "You"} — shared screen`}
            color={self?.color ?? "#4ea1ff"}
            stream={screenStream}
            isSelf
            micOn={micEnabled}
            screenSharing
            fullscreenable
            className={
              fullscreen
                ? tileClass
                : "col-span-full aspect-video w-full min-w-0 md:aspect-[16/8]"
            }
          />
        ) : null}
        {self && !localIsSharing ? (
          <VideoTile
            name={self.name}
            color={self.color}
            stream={localStream}
            isSelf
            micOn={micEnabled}
            camOff={!camEnabled}
            className={cn(
              tileClass,
              !fullscreen && "aspect-video w-full min-w-0",
            )}
          />
        ) : null}
        {cameraParticipants.map((participant) => (
          <VideoTile
            key={participant.id}
            name={participant.name}
            color={participant.color}
            stream={remoteStreams[participant.id] ?? null}
            isSelf={false}
            micOn={participant.mic}
            camOff={!participant.cam}
            className={cn(
              tileClass,
              !fullscreen && "aspect-video w-full min-w-0",
            )}
          />
        ))}
      </div>
    </section>
  );
}
