"use client";

import { useEffect, useRef } from "react";
import { MicOff, MonitorUp } from "lucide-react";
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
  className,
}: VideoTileProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const safeColor = safeParticipantColor(color);
  const hasVideo = Boolean(stream?.getVideoTracks().length) && !camOff;

  useEffect(() => {
    const element = videoRef.current;
    if (element && element.srcObject !== stream) {
      element.srcObject = stream;
      if (stream) void element.play().catch(() => undefined);
    }
  }, [stream, hasVideo]);

  return (
    <div
      className={cn(
        "group relative aspect-video w-[132px] shrink-0 overflow-hidden rounded-lg border border-border bg-black/50",
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
    const element = ref.current;
    if (!element) return;
    element.srcObject = stream;
    void element.play().catch(() => undefined);
  }, [stream]);

  return <audio ref={ref} autoPlay playsInline className="hidden" />;
}
