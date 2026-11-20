"use client";

import { useEffect, useRef, useState } from "react";
import { Maximize2, MicOff, Minimize2, MonitorUp } from "lucide-react";
import { cn, initials } from "@/lib/utils";
import { safeParticipantColor } from "@/utils/color";

interface VideoTileProps {
  name: string;
  color: string;
  stream: MediaStream | null;
  isSelf: boolean;
  micOn: boolean;
  screenSharing?: boolean;
  camOff?: boolean;
  /** Shows a control that fullscreens just this tile (screen shares). */
  fullscreenable?: boolean;
  className?: string;
}

export function VideoTile({
  name,
  color,
  stream,
  isSelf,
  micOn,
  screenSharing,
  camOff,
  fullscreenable = false,
  className,
}: VideoTileProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const safeColor = safeParticipantColor(color);
  const hasVideo = Boolean(stream?.getVideoTracks().length) && !camOff;

  useEffect(() => {
    if (!fullscreenable) return;
    const onChange = (): void => {
      setIsFullscreen(document.fullscreenElement === containerRef.current);
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, [fullscreenable]);

  const toggleFullscreen = async (): Promise<void> => {
    const element = containerRef.current;
    if (!element) return;
    try {
      if (document.fullscreenElement === element) {
        await document.exitFullscreen();
      } else {
        await element.requestFullscreen();
      }
    } catch {
      // The browser can refuse fullscreen outside a user gesture; the tile
      // simply stays inline in that case.
    }
  };

  useEffect(() => {
    const element = videoRef.current;
    if (element && element.srcObject !== stream) {
      element.srcObject = stream;
      if (stream) void element.play().catch(() => undefined);
    }
  }, [stream, hasVideo]);

  return (
    <div
      ref={containerRef}
      className={cn(
        "group relative aspect-video w-[132px] shrink-0 overflow-hidden rounded-lg border border-border bg-black/50",
        fullscreenable &&
          "[&:fullscreen]:aspect-auto [&:fullscreen]:h-screen [&:fullscreen]:w-screen [&:fullscreen]:rounded-none [&:fullscreen]:border-0",
        className,
      )}
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className={cn(
          "h-full w-full",
          screenSharing ? "object-contain" : "object-cover",
          !hasVideo && "hidden",
        )}
      />
      {!hasVideo ? (
        <div
          className="flex h-full w-full items-center justify-center"
          style={{
            background: `linear-gradient(145deg, ${safeColor}22, transparent)`,
          }}
        >
          <span
            className="flex h-9 w-9 items-center justify-center rounded-full text-xs font-semibold"
            style={{ backgroundColor: `${safeColor}33`, color: safeColor }}
          >
            {initials(name)}
          </span>
        </div>
      ) : null}
      {fullscreenable ? (
        <button
          type="button"
          onClick={() => void toggleFullscreen()}
          aria-label={
            isFullscreen ? "Exit fullscreen" : "Fullscreen shared screen"
          }
          className="absolute right-1.5 top-1.5 z-10 flex h-7 w-7 items-center justify-center rounded-md bg-black/60 text-white/90 shadow-sm backdrop-blur-sm transition-colors hover:bg-black/80 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
        >
          {isFullscreen ? (
            <Minimize2 className="h-3.5 w-3.5" />
          ) : (
            <Maximize2 className="h-3.5 w-3.5" />
          )}
        </button>
      ) : null}
      <div className="absolute inset-x-0 bottom-0 flex items-center gap-1 bg-gradient-to-t from-black/80 to-transparent px-1.5 py-1">
        <span className="truncate text-[9px] font-medium text-white/90">
          {isSelf ? (screenSharing ? "You — screen" : "You") : name}
        </span>
        {!micOn ? (
          <MicOff className="h-2.5 w-2.5 shrink-0 text-rose-400" />
        ) : null}
        {screenSharing ? (
          <MonitorUp className="h-2.5 w-2.5 shrink-0 text-violet-300" />
        ) : null}
      </div>
    </div>
  );
}

/** Remote audio always plays through a dedicated element (video tiles are muted). */
export function RemoteAudio({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const audio = ref.current;
    if (!audio) return;
    let cancelled = false;
    let waitingForGesture = false;

    function cleanupGesture(): void {
      document.removeEventListener("pointerdown", retry, true);
      document.removeEventListener("keydown", retry, true);
      document.removeEventListener("touchstart", retry, true);
      document.removeEventListener("visibilitychange", onVisibility);
      waitingForGesture = false;
    }

    function waitForGesture(): void {
      if (cancelled || waitingForGesture) return;
      waitingForGesture = true;
      document.addEventListener("pointerdown", retry, true);
      document.addEventListener("keydown", retry, true);
      document.addEventListener("touchstart", retry, true);
      document.addEventListener("visibilitychange", onVisibility);
    }

    function onVisibility(): void {
      if (document.visibilityState === "visible") retry();
    }

    function retry(): void {
      if (cancelled) return;
      cleanupGesture();
      void attemptPlayback();
    }

    async function attemptPlayback(): Promise<void> {
      if (cancelled) return;
      const element = audio;
      if (!element) return;
      try {
        // Browsers reject unmuted autoplay until the document has user
        // activation. Retry on the next interaction instead of silently
        // leaving the call mute; the element stays mounted so playback
        // starts as soon as the gesture arrives.
        await element.play();
        cleanupGesture();
      } catch (error) {
        if (cancelled) return;
        if (process.env.NODE_ENV !== "production") {
          console.warn(
            "[codesync] Remote audio is waiting for user activation",
            error,
          );
        }
        waitForGesture();
      }
    }

    // A peer can publish camera and microphone as separate tracks. If the
    // audio element was already mounted for a video-only stream, start
    // playback when the microphone track finally arrives.
    function onAddTrack(event: MediaStreamTrackEvent): void {
      if (event.track.kind === "audio") void attemptPlayback();
    }

    stream.addEventListener("addtrack", onAddTrack);
    audio.srcObject = stream;
    void attemptPlayback();

    return () => {
      cancelled = true;
      cleanupGesture();
      stream.removeEventListener("addtrack", onAddTrack);
      audio.srcObject = null;
      audio.pause();
    };
  }, [stream]);

  return (
    <audio
      ref={ref}
      autoPlay
      playsInline
      preload="auto"
      aria-hidden="true"
      className="sr-only"
    />
  );
}
