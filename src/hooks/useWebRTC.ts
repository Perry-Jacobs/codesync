"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useSession } from "@/components/providers/session-provider";
import { webrtcBus } from "@/lib/buses";
import { PeerMesh } from "@/lib/webrtc/peerMesh";
import { canScreenShare } from "@/lib/acl";
import { apiUrl } from "@/lib/api-client";
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

export interface WebRtcApi {
  localStream: MediaStream | null;
  micEnabled: boolean;
  camEnabled: boolean;
  screenSharing: boolean;
  canShareScreen: boolean;
  permissionError: string | null;
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
  const participants = useRoomStore((state) => state.participants);
  const micEnabled = useMediaStore((state) => state.micEnabled);
  const camEnabled = useMediaStore((state) => state.camEnabled);
  const screenSharing = useMediaStore((state) => state.screenSharing);
  const permissionError = useMediaStore((state) => state.permissionError);
  const localStream = useMediaStore((state) => state.localStream);

  const [iceServers, setIceServers] = useState<RTCIceServer[] | null>(null);
  const meshRef = useRef<PeerMesh | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<MediaStreamTrack | null>(null);
  const camRef = useRef<MediaStreamTrack | null>(null);
  const screenRef = useRef<MediaStreamTrack | null>(null);
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
          payload.iceServers ?? [{ urls: "stun:stun.l.google.com:19302" }],
        );
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError")
          return;
        setIceServers([{ urls: "stun:stun.l.google.com:19302" }]);
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
    if (!selfId || !iceServers) return;
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
      onError: (message) => toast.error(message),
    });
    meshRef.current = mesh;
    if (audioRef.current) void mesh.setAudioTrack(audioRef.current);
    const video = screenRef.current ?? camRef.current;
    if (video) void mesh.setVideoTrack(video);

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
  }, [iceServers, selfId, send]);

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

  // Incoming signals.
  useEffect(() => {
    return webrtcBus.on((payload) => {
      void meshRef.current?.handleSignal(payload.fromId, payload.signal);
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
          track.onended = () => useMediaStore.getState().setCamEnabled(false);
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
      if (!screenRef.current) void meshRef.current?.setVideoTrack(null);
    }
    return () => {
      cancelled = true;
    };
  }, [camEnabled]);

  // Screen share.
  useEffect(() => {
    let cancelled = false;
    if (screenSharing && !screenRef.current) {
      if (!navigator.mediaDevices?.getDisplayMedia) {
        useMediaStore.getState().setScreenSharing(false);
        useMediaStore
          .getState()
          .setPermissionError(
            "Screen sharing is not available in this browser",
          );
        return;
      }
      void navigator.mediaDevices
        .getDisplayMedia({ video: { frameRate: { ideal: 30 } }, audio: false })
        .then((media) => {
          const track = media.getVideoTracks()[0];
          if (!track) return;
          if (cancelled) {
            track.stop();
            return;
          }
          screenRef.current = track;
          useMediaStore.getState().setScreenStream(new MediaStream([track]));
          track.onended = () =>
            useMediaStore.getState().setScreenSharing(false);
          void meshRef.current?.setVideoTrack(track);
        })
        .catch(() => {
          useMediaStore.getState().setScreenSharing(false);
          useMediaStore.getState().setScreenStream(null);
          toast.error("Screen share was cancelled");
        });
    } else if (!screenSharing && screenRef.current) {
      const track = screenRef.current;
      screenRef.current = null;
      track.stop();
      useMediaStore.getState().setScreenStream(null);
      void meshRef.current?.setVideoTrack(camRef.current);
    }
    return () => {
      cancelled = true;
    };
  }, [screenSharing]);

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
    send("request_speak", { enabled: true });
    toast.info("Asked the host for speak access");
  }, [send]);

  const toggleMic = useCallback(() => {
    if (!self?.canSpeak) {
      requestSpeak();
      return;
    }
    useMediaStore
      .getState()
      .setMicEnabled(!useMediaStore.getState().micEnabled);
  }, [requestSpeak, self?.canSpeak]);

  const toggleCam = useCallback(() => {
    useMediaStore
      .getState()
      .setCamEnabled(!useMediaStore.getState().camEnabled);
  }, []);

  const toggleScreen = useCallback(async () => {
    if (!canShareScreen) {
      toast.error("Screen sharing is limited to the host and co-hosts");
      return;
    }
    useMediaStore
      .getState()
      .setScreenSharing(!useMediaStore.getState().screenSharing);
  }, [canShareScreen]);

  return {
    localStream,
    micEnabled,
    camEnabled,
    screenSharing,
    canShareScreen,
    permissionError,
    toggleMic,
    toggleCam,
    toggleScreen,
    requestSpeak,
  };
}
