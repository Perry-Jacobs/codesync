"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { useSession } from "@/components/providers/session-provider";
import { peerResetBus, webrtcBus } from "@/lib/buses";
import { PeerMesh } from "@/lib/webrtc/peerMesh";
import { canScreenShare } from "@/lib/acl";
import { apiUrl } from "@/lib/api-client";
import type { ServerPayloads } from "@/lib/ws-protocol";
import { useMediaStore, type PeerConnectionState } from "@/stores/media.store";
import { useRoomStore } from "@/stores/room.store";

function mapPeerState(
  state: RTCPeerConnectionState | RTCIceConnectionState,
): PeerConnectionState {
  if (state === "connected") return "connected";
  if (state === "connecting") return "connecting";
  if (state === "failed") return "failed";
  if (state === "disconnected") return "disconnected";
  return "new";
}

function permissionMessage(error: unknown, device: string): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError")
      return `${device} permission was denied`;
    if (error.name === "NotFoundError")
      return `No ${device.toLowerCase()} was found`;
    if (error.name === "NotReadableError")
      return `The ${device.toLowerCase()} is in use by another app`;
  }
  return `Could not start the ${device.toLowerCase()}`;
}

/**
 * Used when the RTC config endpoint is unreachable. Two independent STUN
 * servers raise the odds of a direct path when the deployment has not been
 * given a TURN server yet.
 */
const FALLBACK_ICE_SERVERS: RTCIceServer[] = [
  {
    urls: [
      "stun:stun.l.google.com:19302",
      "stun:stun1.l.google.com:19302",
    ],
  },
];

export interface WebRtcApi {
  localStream: MediaStream | null;
  micEnabled: boolean;
  camEnabled: boolean;
  screenSharing: boolean;
  canShareScreen: boolean;
  permissionError: string | null;
  speakRequested: boolean;
  toggleMic(): void;
  toggleCam(): void;
  toggleScreen(): Promise<void>;
  requestSpeak(): void;
}

/** Owns the camera/mic/screen tracks and keeps the peer mesh in sync. */
export function useWebRTC(): WebRtcApi {
  const { send } = useSession();
  const self = useRoomStore((state) => state.self);
  const room = useRoomStore((state) => state.room);
  const status = useRoomStore((state) => state.status);
  const participants = useRoomStore((state) => state.participants);
  const micEnabled = useMediaStore((state) => state.micEnabled);
  const camEnabled = useMediaStore((state) => state.camEnabled);
  const screenSharing = useMediaStore((state) => state.screenSharing);
  const permissionError = useMediaStore((state) => state.permissionError);
  const localStream = useMediaStore((state) => state.localStream);
  const speakRequested = useMediaStore((state) => state.speakRequested);

  const [iceServers, setIceServers] = useState<RTCIceServer[] | null>(null);
  // The preview stream is mutated in place when tracks are added or removed,
  // and Chrome does not emit `addtrack` for MediaStream here. Bump this so
  // consumers (the video dock's fullscreen availability, for one) re-render
  // when the camera track actually changes.
  const [, bumpMediaRevision] = useReducer(
    (revision: number) => revision + 1,
    0,
  );
  const meshRef = useRef<PeerMesh | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<MediaStreamTrack | null>(null);
  const camRef = useRef<MediaStreamTrack | null>(null);
  const screenRef = useRef<MediaStreamTrack | null>(null);
  const screenRequestRef = useRef(0);
  const screenCapturePendingRef = useRef(false);
  const lastSpeakRequestRef = useRef(0);
  const pendingSignalsRef = useRef<Array<ServerPayloads["webrtc_signal"]>>([]);
  const selfId = self?.id ?? null;

  const canShareScreen = useMemo(
    () =>
      self && room ? canScreenShare(self, room.allowGuestScreenShare) : false,
    [room, self],
  );

  // RTC configuration (STUN/TURN) from the server.
  useEffect(() => {
    const controller = new AbortController();
    void fetch(apiUrl("/api/rtc/config"), {
      cache: "no-store",
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok)
          throw new Error(`RTC config request failed: ${response.status}`);
        return response.json() as Promise<{ iceServers?: RTCIceServer[] }>;
      })
      .then((payload) => {
        setIceServers(
          payload.iceServers?.length
            ? payload.iceServers
            : FALLBACK_ICE_SERVERS,
        );
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError")
          return;
        setIceServers(FALLBACK_ICE_SERVERS);
      });
    return () => controller.abort();
  }, []);

  // Local preview stream (one instance for the whole session).
  useEffect(() => {
    const stream = new MediaStream();
    streamRef.current = stream;
    useMediaStore.getState().setLocalStream(stream);
    return () => {
      for (const track of stream.getTracks()) track.stop();
      useMediaStore.getState().setLocalStream(null);
      streamRef.current = null;
    };
  }, []);

  // Mesh lifecycle.
  useEffect(() => {
    // `room_state` contains the participant IDs before the server's
    // authoritative `admitted` message arrives. Starting the mesh at that
    // point can emit an offer while the socket still rejects non-chat frames.
    if (!selfId || !iceServers || status !== "admitted") return;
    const mesh = new PeerMesh({
      iceServers,
      selfId,
      sendSignal: (targetId, signal) =>
        send("webrtc_signal", { targetId, signal }),
      onRemoteStream: (participantId, stream) =>
        useMediaStore.getState().setRemoteStream(participantId, stream),
      onStateChange: (participantId, state) =>
        useMediaStore
          .getState()
          .setPeerState(participantId, mapPeerState(state)),
      onError: (message) => {
        console.error("[codesync] WebRTC error", message);
        toast.error(message);
      },
    });
    meshRef.current = mesh;
    if (audioRef.current) void mesh.setAudioTrack(audioRef.current);
    const video = screenRef.current ?? camRef.current;
    if (video) void mesh.setVideoTrack(video);

    const pendingSignals = pendingSignalsRef.current.splice(0);
    for (const payload of pendingSignals) {
      void mesh.handleSignal(payload.fromId, payload.signal);
    }

    const current = useRoomStore.getState().participants;
    for (const participant of current) {
      if (
        participant.id !== selfId &&
        participant.state === "ADMITTED" &&
        selfId < participant.id
      ) {
        mesh.ensurePeer(participant.id);
      }
    }

    return () => {
      mesh.closeAll();
      meshRef.current = null;
    };
  }, [iceServers, selfId, send, status]);

  // Keep peers aligned with the admitted participant list.
  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh || !selfId) return;
    const ids = new Set(
      participants
        .filter((p) => p.state === "ADMITTED" && p.id !== selfId)
        .map((p) => p.id),
    );
    for (const id of ids) {
      if (selfId < id) mesh.ensurePeer(id);
    }
    for (const id of mesh.peerIds()) {
      if (!ids.has(id)) mesh.removePeer(id);
    }
  }, [participants, selfId]);

  // Signals and transient disconnect events can arrive before the room route
  // mounts or the ICE config finishes loading. Keep only events missed while
  // there is no mesh; the buses deliver their short buffer once when ready.
  useEffect(() => {
    return peerResetBus.on((participantId) => {
      meshRef.current?.removePeer(participantId);
    });
  }, []);

  useEffect(() => {
    return webrtcBus.on((payload) => {
      const mesh = meshRef.current;
      if (!mesh) {
        pendingSignalsRef.current.push(payload);
        return;
      }
      void mesh.handleSignal(payload.fromId, payload.signal);
    });
  }, []);

  // Microphone.
  useEffect(() => {
    let cancelled = false;
    const stream = streamRef.current;
    if (micEnabled && !audioRef.current) {
      if (!navigator.mediaDevices?.getUserMedia) {
        useMediaStore.getState().setMicEnabled(false);
        useMediaStore
          .getState()
          .setPermissionError(
            "Microphone capture is not available in this browser",
          );
        return;
      }
      void navigator.mediaDevices
        .getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        })
        .then((media) => {
          const track = media.getAudioTracks()[0];
          if (!track) return;
          if (cancelled) {
            track.stop();
            return;
          }
          audioRef.current = track;
          // Hint the encoder for voice; Chrome otherwise treats microphone
          // audio as generic and can apply a lower-quality profile.
          track.contentHint = "speech";
          stream?.addTrack(track);
          track.onended = () => useMediaStore.getState().setMicEnabled(false);
          void meshRef.current?.setAudioTrack(track);
          useMediaStore.getState().setPermissionError(null);
        })
        .catch((error: unknown) => {
          useMediaStore.getState().setMicEnabled(false);
          useMediaStore
            .getState()
            .setPermissionError(permissionMessage(error, "Microphone"));
          toast.error(permissionMessage(error, "Microphone"));
        });
    } else if (!micEnabled && audioRef.current) {
      const track = audioRef.current;
      audioRef.current = null;
      track.stop();
      if (stream?.getTracks().includes(track)) stream.removeTrack(track);
      void meshRef.current?.setAudioTrack(null);
    }
    return () => {
      cancelled = true;
    };
  }, [micEnabled]);

  // Camera (screen share takes over the video sender).
  useEffect(() => {
    let cancelled = false;
    const stream = streamRef.current;
    if (camEnabled && !camRef.current) {
      if (!navigator.mediaDevices?.getUserMedia) {
        useMediaStore.getState().setCamEnabled(false);
        useMediaStore
          .getState()
          .setPermissionError(
            "Camera capture is not available in this browser",
          );
        return;
      }
      void navigator.mediaDevices
        .getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        })
        .then((media) => {
          const track = media.getVideoTracks()[0];
          if (!track) return;
          if (cancelled) {
            track.stop();
            return;
          }
          camRef.current = track;
          stream?.addTrack(track);
          bumpMediaRevision();
          track.onended = () => {
            useMediaStore.getState().setCamEnabled(false);
            bumpMediaRevision();
          };
          if (!screenRef.current) void meshRef.current?.setVideoTrack(track);
          useMediaStore.getState().setPermissionError(null);
        })
        .catch((error: unknown) => {
          useMediaStore.getState().setCamEnabled(false);
          useMediaStore
            .getState()
            .setPermissionError(permissionMessage(error, "Camera"));
          toast.error(permissionMessage(error, "Camera"));
        });
    } else if (!camEnabled && camRef.current) {
      const track = camRef.current;
      camRef.current = null;
      track.stop();
      if (stream?.getTracks().includes(track)) stream.removeTrack(track);
      bumpMediaRevision();
      if (!screenRef.current) void meshRef.current?.setVideoTrack(null);
    }
    return () => {
      cancelled = true;
    };
  }, [camEnabled]);

  const stopScreenShare = useCallback(() => {
    screenRequestRef.current += 1;
    screenCapturePendingRef.current = false;
    const track = screenRef.current;
    screenRef.current = null;
    if (track) {
      track.onended = null;
      track.onunmute = null;
      track.onmute = null;
      track.stop();
    }
    useMediaStore.getState().setScreenStream(null);
    useMediaStore.getState().setScreenSharing(false);
    void meshRef.current?.setVideoTrack(camRef.current);
  }, []);

  // A host can revoke guest sharing mid-stream. Stop local capture so the
  // setting takes effect immediately instead of leaving an active, unstoppable
  // screen track behind a disabled button.
  useEffect(() => {
    if (canShareScreen || !screenRef.current) return;
    stopScreenShare();
    toast.info("The host turned off guest screen sharing");
  }, [canShareScreen, stopScreenShare]);

  useEffect(
    () => () => {
      screenRequestRef.current += 1;
      screenCapturePendingRef.current = false;
    },
    [],
  );

  // Publish device state so the server can render badges and enforce grants.
  useEffect(() => {
    if (!selfId) return;
    send("media_state", {
      mic: micEnabled,
      cam: camEnabled,
      screen: screenSharing,
    });
  }, [micEnabled, camEnabled, screenSharing, selfId, send]);

  // Tear everything down when the room unmounts.
  useEffect(() => {
    return () => {
      audioRef.current?.stop();
      camRef.current?.stop();
      screenRef.current?.stop();
      audioRef.current = null;
      camRef.current = null;
      screenRef.current = null;
      useMediaStore.getState().setScreenStream(null);
    };
  }, []);

  const requestSpeak = useCallback(() => {
    const media = useMediaStore.getState();
    const now = Date.now();
    // Let a waiting guest nudge the host again, but do not let repeated
    // clicks turn into a stream of toast prompts.
    if (media.speakRequested && now - lastSpeakRequestRef.current < 4_000) {
      toast.info("Your request is already with the host");
      return;
    }
    media.setSpeakRequested(true);
    lastSpeakRequestRef.current = now;
    send("request_speak", { enabled: true });
    toast.info(
      media.speakRequested
        ? "Asked the host again for speak access"
        : "Asked the host for speak access",
    );
  }, [send]);

  const toggleMic = useCallback(() => {
    const media = useMediaStore.getState();
    if (!self?.canSpeak) {
      requestSpeak();
      return;
    }
    media.setMicEnabled(!media.micEnabled);
  }, [requestSpeak, self?.canSpeak]);

  const toggleCam = useCallback(() => {
    useMediaStore
      .getState()
      .setCamEnabled(!useMediaStore.getState().camEnabled);
  }, []);

  const toggleScreen = useCallback(async () => {
    // Stopping must always be possible, even after the host revokes the
    // permission that allowed the share to start.
    if (screenRef.current) {
      stopScreenShare();
      return;
    }
    if (!canShareScreen) {
      toast.error("Screen sharing is limited to the host and co-hosts");
      return;
    }

    if (screenCapturePendingRef.current) return;
    if (!navigator.mediaDevices?.getDisplayMedia) {
      useMediaStore
        .getState()
        .setPermissionError("Screen sharing is not available in this browser");
      toast.error("Screen sharing is not available in this browser");
      return;
    }

    const requestId = ++screenRequestRef.current;
    screenCapturePendingRef.current = true;
    try {
      // Call capture from the user gesture itself. Starting it from an effect
      // can lose transient browser activation, especially for app/window picks.
      const media = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: 1280, max: 1920 },
          height: { ideal: 720, max: 1080 },
          frameRate: { ideal: 15, max: 15 },
        },
        audio: false,
      });
      const track = media.getVideoTracks()[0];
      if (!track) throw new Error("The selected source did not provide video");
      if (requestId !== screenRequestRef.current) {
        track.stop();
        return;
      }

      screenRef.current = track;
      // Screen content is usually text and UI; tell WebRTC to favour detail
      // over motion so code stays legible at the capped frame rate.
      track.contentHint = "detail";
      track.onended = () => {
        if (screenRef.current !== track) return;
        stopScreenShare();
      };
      track.onunmute = bumpMediaRevision;
      track.onmute = bumpMediaRevision;
      useMediaStore.getState().setScreenStream(new MediaStream([track]));
      useMediaStore.getState().setScreenSharing(true);
      useMediaStore.getState().setPermissionError(null);
      await meshRef.current?.setVideoTrack(track);
    } catch (error) {
      if (requestId === screenRequestRef.current) {
        const message =
          error instanceof DOMException && error.name === "NotAllowedError"
            ? "Screen sharing was cancelled or not allowed"
            : error instanceof Error
              ? error.message
              : "Could not share this screen";
        toast.error(message);
      }
    } finally {
      if (requestId === screenRequestRef.current) {
        screenCapturePendingRef.current = false;
      }
    }
  }, [canShareScreen, stopScreenShare]);

  return {
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
    requestSpeak,
  };
}
