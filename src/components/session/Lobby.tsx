"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  CameraOff,
  Clock,
  Code2,
  Copy,
  DoorOpen,
  Eye,
  Loader2,
  Lock,
  Mic,
  MicOff,
  ShieldCheck,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/components/providers/session-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useTheme } from "@/components/providers/theme-provider";
import { useRoomStore } from "@/stores/room.store";
import type { RoomInfoResponse } from "@/lib/api-types";
import { initials } from "@/lib/utils";
import { clearReconnectCredential } from "@/components/session/lobby-session";

const NAME_KEY = "codesync:name";
const MEDIA_KEY = "codesync:media";

interface MediaPreference {
  mic: boolean;
  cam: boolean;
}

function readMedia(): MediaPreference {
  try {
    const raw = window.localStorage.getItem(MEDIA_KEY);
    if (!raw) return { mic: false, cam: false };
    const parsed = JSON.parse(raw) as Partial<MediaPreference>;
    return { mic: Boolean(parsed.mic), cam: Boolean(parsed.cam) };
  } catch {
    return { mic: false, cam: false };
  }
}

export function Lobby({
  roomKey,
  preview = false,
}: {
  roomKey: string;
  preview?: boolean;
}) {
  const router = useRouter();
  const { connect, disconnect } = useSession();
  const { theme, toggle } = useTheme();
  const room = useRoomStore((state) => state.room);
  const roomStatus = useRoomStore((state) => state.status);
  const error = useRoomStore((state) => state.error);

  const [name, setName] = useState("");
  const [mic, setMic] = useState(false);
  const [cam, setCam] = useState(false);
  const [info, setInfo] = useState<RoomInfoResponse | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitted, setSubmitted] = useState(false);
  const [removed, setRemoved] = useState(false);
  const infoAtCapacityError = useRef<RoomInfoResponse | null>(null);

  useEffect(() => {
    if (!preview) setName(window.localStorage.getItem(NAME_KEY) ?? "");
    const media = readMedia();
    setMic(media.mic);
    setCam(media.cam);
  }, [preview]);

  useEffect(() => {
    let cancelled = false;
    let hasInfo = false;

    const load = async (): Promise<void> => {
      try {
        const response = await fetch(
          `/api/rooms/${encodeURIComponent(roomKey)}`,
          {
            cache: "no-store",
          },
        );
        const payload = (await response.json()) as
          RoomInfoResponse | { error: string };
        if (cancelled) return;
        if (!response.ok || "error" in payload) {
          if (!hasInfo) {
            setLookupError(
              "error" in payload ? payload.error : "Session not found",
            );
          }
        } else {
          hasInfo = true;
          setLookupError(null);
          setInfo(payload);
        }
      } catch {
        if (!cancelled && !hasInfo)
          setLookupError("Could not reach the server");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    const interval = window.setInterval(() => {
      // Polling a lobby the user cannot see burns requests for nothing; the
      // next tick after the tab becomes visible refreshes the state.
      if (document.visibilityState === "hidden") return;
      void load();
    }, 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [roomKey]);

  const join = useCallback(() => {
    if (preview) return;
    const displayName = name.trim();
    if (!displayName) {
      toast.error("Enter a display name");
      return;
    }
    window.localStorage.setItem(NAME_KEY, displayName);
    window.localStorage.setItem(MEDIA_KEY, JSON.stringify({ mic, cam }));
    const started = connect({ displayName, mic, cam, claimHost: false });
    if (!started) toast.error("Could not start the connection");
    else setSubmitted(true);
  }, [cam, connect, mic, name, preview]);

  const handleRemoved = useCallback(() => {
    clearReconnectCredential(roomKey);
    setRemoved(true);
    setSubmitted(false);
    disconnect();
  }, [disconnect, roomKey]);

  useEffect(() => {
    if (
      roomStatus === "error" &&
      error === "This participant can no longer rejoin the session"
    ) {
      handleRemoved();
    }
  }, [error, handleRemoved, roomStatus]);

  const leave = useCallback(() => {
    disconnect();
    router.push("/");
  }, [disconnect, router]);

  const keyCopy = useCallback(() => {
    void navigator.clipboard.writeText(roomKey);
    toast.success("Session key copied");
  }, [roomKey]);

  const hostName = info?.hostName ?? room?.title ?? "the host";
  const locked = info?.status === "locked";
  const atCapacity =
    info !== null &&
    info.participantCount >= info.maxParticipants &&
    info.maxParticipants > 0;
  const capacityError =
    roomStatus === "error" && /session is full/i.test(error ?? "");

  useEffect(() => {
    if (!capacityError) {
      infoAtCapacityError.current = null;
      return;
    }
    infoAtCapacityError.current ??= info;
    setSubmitted(false);
    if (error) toast.dismiss(`PARTICIPANT_LIMIT:${error}`);
  }, [capacityError, error, info]);

  useEffect(() => {
    if (
      !capacityError ||
      info === null ||
      atCapacity ||
      info === infoAtCapacityError.current
    ) {
      return;
    }
    useRoomStore.getState().setStatus("idle");
    useRoomStore.getState().setError(null);
  }, [atCapacity, capacityError, info]);

  const terminal = useMemo(() => {
    if (removed) return "You were removed from this session";
    if (lookupError) return lookupError;
    if (roomStatus === "denied") return error ?? "The host denied your request";
    if (roomStatus === "kicked")
      return error ?? "You were removed from the session";
    if (roomStatus === "ended") return "The host ended this session";
    if (roomStatus === "error" && !capacityError)
      return error ?? "Could not join this session";
    return null;
  }, [capacityError, error, lookupError, removed, roomStatus]);

  if (removed) {
    return (
      <main className="relative flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-6 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
          <DoorOpen className="h-6 w-6" />
        </div>
        <h1 className="text-xl font-semibold">
          You were removed from this session
        </h1>
        <p className="max-w-md text-sm text-muted-foreground">
          Your previous participant access has ended. You can still join again
          as a new participant if the host has left the session open and there
          is space.
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button
            onClick={() => {
              clearReconnectCredential(roomKey);
              setRemoved(false);
              setSubmitted(true);
              const started = connect({
                displayName: name.trim(),
                mic,
                cam,
                claimHost: false,
              });
              if (!started) {
                setSubmitted(false);
                toast.error("Could not start the connection");
              }
            }}
            disabled={locked || atCapacity}
          >
            Join again as a new participant
          </Button>
          <Button asChild variant="outline">
            <Link href="/">
              <ArrowLeft className="h-4 w-4" /> Back to home
            </Link>
          </Button>
        </div>
        {locked ? (
          <p className="text-xs text-muted-foreground">
            The host has locked this session for new guests.
          </p>
        ) : atCapacity ? (
          <p className="text-xs text-muted-foreground">This session is full.</p>
        ) : null}
      </main>
    );
  }

  if (terminal) {
    return (
      <main className="relative flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-6 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
          <DoorOpen className="h-6 w-6" />
        </div>
        <h1 className="text-xl font-semibold">This session is not available</h1>
        <p className="max-w-md text-sm text-muted-foreground">{terminal}</p>
        <Button asChild variant="outline">
          <Link href="/">
            <ArrowLeft className="h-4 w-4" /> Back to home
          </Link>
        </Button>
      </main>
    );
  }

  if (
    roomStatus === "waiting" ||
    (submitted &&
      roomStatus !== "admitted" &&
      roomStatus !== "denied" &&
      roomStatus !== "kicked" &&
      roomStatus !== "ended" &&
      roomStatus !== "error")
  ) {
    return (
      <main className="relative flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-6 text-center">
        <div className="pointer-events-none absolute inset-0 grid-backdrop opacity-30" />
        <div className="relative flex flex-col items-center gap-4">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/15 text-primary">
            <Clock className="h-6 w-6 animate-pulse" />
          </span>
          <h1 className="text-xl font-semibold">Waiting for the host</h1>
          <p className="max-w-sm text-sm text-muted-foreground">
            {info?.hostName ?? "The host"} has to admit you before you can see
            the workspace.
          </p>
          <Badge variant="warning" className="gap-1">
            <Lock className="h-3 w-3" /> waiting room
          </Badge>
          <Button variant="outline" onClick={leave} className="mt-2">
            Leave
          </Button>
        </div>
      </main>
    );
  }

  return (
    <main className="relative min-h-screen overflow-hidden bg-background">
      <div className="pointer-events-none absolute inset-0 grid-backdrop opacity-30" />
      <div className="relative mx-auto flex max-w-5xl items-center justify-between px-6 py-5">
        <Button asChild variant="ghost" size="sm">
          <Link href="/">
            <ArrowLeft className="h-4 w-4" /> Home
          </Link>
        </Button>
        <Button variant="ghost" size="sm" onClick={toggle}>
          {theme === "dark" ? "Light mode" : "Dark mode"}
        </Button>
      </div>

      <div className="relative mx-auto grid max-w-5xl gap-6 px-6 pb-16 pt-4 lg:grid-cols-[1.1fr_0.9fr]">
        <section className="flex flex-col justify-center">
          <div className="flex items-center gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/15 text-primary">
              <Code2 className="h-4 w-4" />
            </span>
            <span className="text-sm font-semibold">CodeSync session</span>
          </div>
          <h1 className="mt-5 text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
            {loading
              ? "Loading session…"
              : (info?.title ?? "Untitled workspace")}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Hosted by <span className="text-foreground">{hostName}</span>
            {info
              ? ` · ${info.workspaceMode === "local-fs" ? "host folder" : "shared workspace"}`
              : ""}
          </p>

          <div className="mt-6 flex flex-wrap items-center gap-2">
            <Badge variant={locked ? "warning" : "success"} className="gap-1">
              {locked ? (
                <Lock className="h-3 w-3" />
              ) : (
                <ShieldCheck className="h-3 w-3" />
              )}
              {locked ? "Locked" : "Open"}
            </Badge>
            <Badge variant="outline" className="gap-1">
              <Users className="h-3 w-3" /> {info?.participantCount ?? 0}/
              {info?.maxParticipants ?? 8}
            </Badge>
            {info?.admitMode === "manual" ? (
              <Badge variant="secondary" className="gap-1">
                <Clock className="h-3 w-3" /> Host admits guests
              </Badge>
            ) : null}
          </div>

          <button
            type="button"
            onClick={keyCopy}
            className="mt-6 flex w-fit items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 font-mono text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            {roomKey}
            <Copy className="h-3.5 w-3.5" />
          </button>

          <div className="mt-8 flex items-end gap-3">
            <div className="flex -space-x-2">
              {[0, 1, 2].map((index) => (
                <span
                  key={index}
                  className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-background bg-secondary text-[10px] font-semibold text-muted-foreground"
                >
                  {["M", "S", "A"][index]}
                </span>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Up to {info?.maxParticipants ?? 8} people · live cursors · voice
              &amp; video
            </p>
          </div>
        </section>

        <section className="rounded-2xl border border-border bg-card p-6 shadow-xl">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold">Join the session</h2>
            {preview ? (
              <Badge variant="secondary" className="gap-1">
                <Eye className="h-3 w-3" /> Preview
              </Badge>
            ) : null}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {preview
              ? "This is exactly what guests see before they join."
              : "Pick how you appear. You can change everything later."}
          </p>

          <div className="mt-5 space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="display-name">Display name</Label>
              <div className="flex items-center gap-2">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
                  {initials(name || "You")}
                </span>
                <Input
                  id="display-name"
                  autoFocus
                  maxLength={48}
                  placeholder="Your name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") join();
                  }}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              {/*
                The tile is a div, not a button: the Switch renders its own
                <button>, and buttons cannot nest (invalid HTML + hydration
                mismatch). The Switch keeps its own hit area and keyboard
                handling; the tile toggles for clicks anywhere else.
              */}
              <div
                className={`flex items-center justify-between rounded-lg border p-3 text-left text-xs transition-colors ${
                  mic
                    ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-400"
                    : "border-border"
                }`}
              >
                <label
                  htmlFor="join-mic"
                  className="flex cursor-pointer items-center gap-2"
                >
                  {mic ? (
                    <Mic className="h-4 w-4" />
                  ) : (
                    <MicOff className="h-4 w-4" />
                  )}
                  Mic
                </label>
                <Switch
                  id="join-mic"
                  checked={mic}
                  onCheckedChange={setMic}
                  aria-label="Microphone"
                />
              </div>
              <div
                className={`flex items-center justify-between rounded-lg border p-3 text-left text-xs transition-colors ${
                  cam
                    ? "border-sky-500/50 bg-sky-500/10 text-sky-400"
                    : "border-border"
                }`}
              >
                <label
                  htmlFor="join-cam"
                  className="flex cursor-pointer items-center gap-2"
                >
                  {cam ? (
                    <Camera className="h-4 w-4" />
                  ) : (
                    <CameraOff className="h-4 w-4" />
                  )}
                  Camera
                </label>
                <Switch
                  id="join-cam"
                  checked={cam}
                  onCheckedChange={setCam}
                  aria-label="Camera"
                />
              </div>
            </div>

            {atCapacity || capacityError ? (
              <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-400">
                This session is full
              </p>
            ) : locked ? (
              <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-400">
                The host locked this session. New guests cannot join right now.
              </p>
            ) : null}

            {preview ? (
              <Button className="w-full" size="lg" variant="outline" disabled>
                <Eye className="h-4 w-4" /> Preview only
              </Button>
            ) : (
              <Button
                className="w-full"
                size="lg"
                onClick={join}
                disabled={loading || locked || atCapacity || capacityError}
              >
                {submitted ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <ArrowRight className="h-4 w-4" />
                )}
                Join session
              </Button>
            )}
            <p className="text-center text-[11px] text-muted-foreground">
              {preview
                ? "Open the invite link in a private window to join as a guest."
                : "By joining you agree to let the host moderate your access."}
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}
