"use client";

import type { ServerPayloads } from "@/lib/ws-protocol";

export type RtcSignal = ServerPayloads["webrtc_signal"]["signal"];
export type PeerState = RTCPeerConnectionState;

interface PeerEntry {
  pc: RTCPeerConnection;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  remoteStream: MediaStream;
  pendingCandidates: RTCIceCandidateInit[];
}

export interface PeerMeshOptions {
  iceServers: RTCIceServer[];
  selfId: string;
  sendSignal(targetId: string, signal: RtcSignal): void;
  onRemoteStream(participantId: string, stream: MediaStream | null): void;
  onStateChange(participantId: string, state: PeerState): void;
  onError?(message: string): void;
}

/**
 * Full-mesh WebRTC with one deterministic initiator per pair: the participant
 * with the lexicographically smaller id offers, which removes glare entirely.
 * Media toggles use replaceTrack on pre-created audio/video transceivers, so
 * they never require renegotiation.
 */
export class PeerMesh {
  private readonly peers = new Map<string, PeerEntry>();
  private signalQueue: Promise<void> = Promise.resolve();
  private audioTrack: MediaStreamTrack | null = null;
  private videoTrack: MediaStreamTrack | null = null;

  constructor(private readonly options: PeerMeshOptions) {}

  hasPeer(peerId: string): boolean {
    return this.peers.has(peerId);
  }

  peerIds(): string[] {
    return [...this.peers.keys()];
  }

  ensurePeer(peerId: string): void {
    if (peerId === this.options.selfId) return;
    let entry = this.peers.get(peerId);
    if (entry) return;

    const polite = this.options.selfId > peerId;
    const pc = new RTCPeerConnection({ iceServers: this.options.iceServers });
    const remoteStream = new MediaStream();
    entry = {
      pc,
      polite,
      makingOffer: false,
      ignoreOffer: false,
      remoteStream,
      pendingCandidates: [],
    };
    this.peers.set(peerId, entry);

    // Only the deterministic initiator pre-creates transceivers. The answerer
    // derives them from the remote offer; pre-creating them on both sides can
    // produce duplicate media sections and leave tracks attached to inactive
    // transceivers.
    if (!polite) {
      const audio = pc.addTransceiver("audio", { direction: "sendrecv" });
      const video = pc.addTransceiver("video", { direction: "sendrecv" });
      if (this.audioTrack) void audio.sender.replaceTrack(this.audioTrack);
      if (this.videoTrack) void video.sender.replaceTrack(this.videoTrack);
    }

    pc.onnegotiationneeded = () => {
      // Only the initiator offers; the polite side always answers.
      if (entry?.polite) return;
      void this.negotiate(peerId, entry);
    };

    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      this.options.sendSignal(peerId, {
        type: "candidate",
        candidate: event.candidate.toJSON(),
      });
    };

    pc.ontrack = (event) => {
      const stream = entry?.remoteStream;
      if (!stream) return;
      const track = event.track;

      // A receiver track exists as soon as the transceiver is negotiated,
      // even when the sender has no video. Such a muted track never produces
      // frames and would otherwise be rendered as an empty black tile. Keep
      // remote video in the stream only while it is actually receiving media.
      if (track.kind === "video") {
        const syncTrack = (): void => {
          const receiving = !track.muted && track.readyState === "live";
          const present = stream
            .getTracks()
            .some((current) => current.id === track.id);
          if (receiving && !present) stream.addTrack(track);
          else if (!receiving && present) stream.removeTrack(track);
          this.options.onRemoteStream(
            peerId,
            stream.getTracks().length > 0 ? stream : null,
          );
        };

        track.onunmute = syncTrack;
        track.onmute = syncTrack;
        track.onended = syncTrack;
        syncTrack();
        return;
      }

      if (!stream.getTracks().some((current) => current.id === track.id)) {
        stream.addTrack(track);
      }
      track.onended = () => {
        stream.removeTrack(track);
        this.options.onRemoteStream(
          peerId,
          stream.getTracks().length > 0 ? stream : null,
        );
      };
      this.options.onRemoteStream(peerId, stream);
    };

    pc.onconnectionstatechange = () => {
      this.options.onStateChange(peerId, pc.connectionState);
      if (pc.connectionState === "failed") {
        this.options.onError?.(
          "Media connection failed — check the TURN server",
        );
      }
    };
  }

  private async negotiate(peerId: string, entry: PeerEntry): Promise<void> {
    if (entry.pc.signalingState !== "stable") return;
    try {
      entry.makingOffer = true;
      await entry.pc.setLocalDescription();
      if (!entry.pc.localDescription) return;
      this.options.sendSignal(peerId, {
        type: "offer",
        sdp: entry.pc.localDescription.sdp,
      });
    } catch (error) {
      this.options.onError?.(
        error instanceof Error ? error.message : "Could not negotiate media",
      );
    } finally {
      entry.makingOffer = false;
    }
  }

  handleSignal(peerId: string, signal: RtcSignal): Promise<void> {
    const processing = this.signalQueue.then(() =>
      this.processSignal(peerId, signal),
    );
    this.signalQueue = processing.catch(() => undefined);
    return processing;
  }

  private async processSignal(
    peerId: string,
    signal: RtcSignal,
  ): Promise<void> {
    this.ensurePeer(peerId);
    const entry = this.peers.get(peerId);
    if (!entry) return;
    const { pc } = entry;

    try {
      if (signal.type === "offer") {
        const collision = entry.makingOffer || pc.signalingState !== "stable";
        if (collision && !entry.polite) return;
        if (collision && entry.polite) {
          await pc.setLocalDescription({ type: "rollback" });
        }
        await pc.setRemoteDescription({ type: "offer", sdp: signal.sdp });
        await this.flushCandidates(entry);

        // The remote offer created one transceiver per media section. Make
        // them send-capable and attach the local tracks before creating the
        // answer so the answerer can publish its camera and microphone.
        const audio = pc
          .getTransceivers()
          .find((tx) => tx.receiver.track.kind === "audio");
        const video = pc
          .getTransceivers()
          .find((tx) => tx.receiver.track.kind === "video");
        if (audio) {
          audio.direction = "sendrecv";
          if (this.audioTrack) await audio.sender.replaceTrack(this.audioTrack);
        }
        if (video) {
          video.direction = "sendrecv";
          if (this.videoTrack) await video.sender.replaceTrack(this.videoTrack);
        }

        await pc.setLocalDescription();
        if (!pc.localDescription) return;
        this.options.sendSignal(peerId, {
          type: "answer",
          sdp: pc.localDescription.sdp,
        });
        return;
      }

      if (signal.type === "answer") {
        if (pc.signalingState !== "have-local-offer") return;
        await pc.setRemoteDescription({ type: "answer", sdp: signal.sdp });
        await this.flushCandidates(entry);
        return;
      }

      if (signal.type === "candidate") {
        if (!pc.remoteDescription) {
          entry.pendingCandidates.push(signal.candidate);
          return;
        }
        try {
          await pc.addIceCandidate(signal.candidate);
        } catch {
          // Stale candidates after a rollback are expected; ignore them.
        }
      }
    } catch (error) {
      if (!entry.ignoreOffer) {
        this.options.onError?.(
          error instanceof Error ? error.message : "Media signal failed",
        );
      }
    }
  }

  private async flushCandidates(entry: PeerEntry): Promise<void> {
    for (const candidate of entry.pendingCandidates.splice(0)) {
      try {
        await entry.pc.addIceCandidate(candidate);
      } catch {
        // Ignore candidates that arrived after the description changed.
      }
    }
  }

  async setAudioTrack(track: MediaStreamTrack | null): Promise<void> {
    this.audioTrack = track;
    await Promise.all(
      [...this.peers.values()].map(async (entry) => {
        const sender = entry.pc
          .getTransceivers()
          .find((tx) => tx.receiver.track.kind === "audio")?.sender;
        if (!sender) return;
        try {
          await sender.replaceTrack(track);
        } catch (error) {
          this.options.onError?.(
            error instanceof Error
              ? error.message
              : "Could not update the microphone for a participant",
          );
        }
      }),
    );
  }

  async setVideoTrack(track: MediaStreamTrack | null): Promise<void> {
    this.videoTrack = track;
    await Promise.all(
      [...this.peers.values()].map(async (entry) => {
        const sender = entry.pc
          .getTransceivers()
          .find((tx) => tx.receiver.track.kind === "video")?.sender;
        if (!sender) return;
        try {
          await sender.replaceTrack(track);
        } catch (error) {
          this.options.onError?.(
            error instanceof Error
              ? error.message
              : "Could not update the camera or shared screen for a participant",
          );
        }
      }),
    );
  }

  removePeer(peerId: string): void {
    const entry = this.peers.get(peerId);
    if (!entry) return;
    this.peers.delete(peerId);
    for (const track of entry.remoteStream.getTracks()) track.stop();
    entry.pc.onnegotiationneeded = null;
    entry.pc.onicecandidate = null;
    entry.pc.ontrack = null;
    entry.pc.onconnectionstatechange = null;
    entry.pc.close();
    this.options.onStateChange(peerId, "disconnected");
    this.options.onRemoteStream(peerId, null);
  }

  closeAll(): void {
    for (const peerId of [...this.peers.keys()]) this.removePeer(peerId);
  }
}
