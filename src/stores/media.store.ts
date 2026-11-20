"use client";

import { create } from "zustand";

export type PeerConnectionState =
  "new" | "connecting" | "connected" | "disconnected" | "failed";

interface MediaState {
  micEnabled: boolean;
  camEnabled: boolean;
  screenSharing: boolean;
  localStream: MediaStream | null;
  remoteStreams: Record<string, MediaStream>;
  peerStates: Record<string, PeerConnectionState>;
  screenStream: MediaStream | null;
  speaking: boolean;
  permissionError: string | null;
  /** True between asking the host for speak access and the host answering. */
  speakRequested: boolean;
  setMicEnabled(enabled: boolean): void;
  setCamEnabled(enabled: boolean): void;
  setScreenSharing(sharing: boolean): void;
  setLocalStream(stream: MediaStream | null): void;
  setScreenStream(stream: MediaStream | null): void;
  setRemoteStream(participantId: string, stream: MediaStream | null): void;
  setPeerState(participantId: string, state: PeerConnectionState): void;
  removePeer(participantId: string): void;
  setSpeaking(speaking: boolean): void;
  setPermissionError(error: string | null): void;
  setSpeakRequested(requested: boolean): void;
  reset(): void;
}

export const useMediaStore = create<MediaState>((set) => ({
  micEnabled: false,
  camEnabled: false,
  screenSharing: false,
  localStream: null,
  screenStream: null,
  remoteStreams: {},
  peerStates: {},
  speaking: false,
  permissionError: null,
  speakRequested: false,

  setMicEnabled: (micEnabled) => set({ micEnabled }),
  setCamEnabled: (camEnabled) => set({ camEnabled }),
  setScreenSharing: (screenSharing) => set({ screenSharing }),
  setLocalStream: (localStream) => set({ localStream }),
  setScreenStream: (screenStream) => set({ screenStream }),

  setRemoteStream: (participantId, stream) =>
    set((state) => {
      const remoteStreams = { ...state.remoteStreams };
      if (stream) remoteStreams[participantId] = stream;
      else delete remoteStreams[participantId];
      return { remoteStreams };
    }),

  setPeerState: (participantId, peerState) =>
    set((state) => ({
      peerStates: { ...state.peerStates, [participantId]: peerState },
    })),

  removePeer: (participantId) =>
    set((state) => {
      const remoteStreams = { ...state.remoteStreams };
      const peerStates = { ...state.peerStates };
      delete remoteStreams[participantId];
      delete peerStates[participantId];
      return { remoteStreams, peerStates };
    }),

  setSpeaking: (speaking) => set({ speaking }),
  setPermissionError: (permissionError) => set({ permissionError }),
  setSpeakRequested: (speakRequested) => set({ speakRequested }),

  reset: () =>
    set({
      micEnabled: false,
      camEnabled: false,
      screenSharing: false,
      localStream: null,
      screenStream: null,
      remoteStreams: {},
      peerStates: {},
      speaking: false,
      permissionError: null,
      speakRequested: false,
    }),
}));
