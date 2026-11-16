import assert from "node:assert/strict";
import test from "node:test";
import { PeerMesh } from "./peerMesh";
import type { RtcSignal } from "./peerMesh";

interface FakeTrack extends MediaStreamTrack {
  fire(event: "mute" | "unmute" | "ended"): void;
}

class MockTrack {
  readonly id: string;
  readonly kind: string;
  readyState: MediaStreamTrackState = "live";
  muted = true;
  onended: ((this: MediaStreamTrack, event: Event) => unknown) | null = null;
  onmute: ((this: MediaStreamTrack, event: Event) => unknown) | null = null;
  onunmute: ((this: MediaStreamTrack, event: Event) => unknown) | null = null;

  constructor(kind: string, id: string) {
    this.kind = kind;
    this.id = id;
  }

  stop(): void {
    this.readyState = "ended";
  }

  fire(event: "mute" | "unmute" | "ended"): void {
    if (event === "mute") this.muted = true;
    if (event === "unmute") this.muted = false;
    if (event === "ended") this.readyState = "ended";
    const callback = this[`on${event}`];
    callback?.call(this as unknown as MediaStreamTrack, new Event(event));
  }
}

class MockMediaStream {
  private tracks: FakeTrack[] = [];

  constructor(tracks: FakeTrack[] = []) {
    this.tracks = [...tracks];
  }

  addTrack(track: FakeTrack): void {
    if (!this.tracks.some((current) => current.id === track.id)) {
      this.tracks.push(track);
    }
  }

  removeTrack(track: FakeTrack): void {
    this.tracks = this.tracks.filter((current) => current.id !== track.id);
  }

  getTracks(): FakeTrack[] {
    return [...this.tracks];
  }

  getVideoTracks(): FakeTrack[] {
    return this.tracks.filter((track) => track.kind === "video");
  }
}

interface MockTransceiver {
  direction: RTCRtpTransceiverDirection;
  sender: {
    track: FakeTrack | null;
    replaceTrack(track: FakeTrack | null): Promise<void>;
  };
  receiver: { track: FakeTrack };
}

class MockPeerConnection {
  static instances: MockPeerConnection[] = [];
  readonly transceivers: MockTransceiver[] = [];
  signalingState: RTCSignalingState = "stable";
  connectionState: RTCPeerConnectionState = "new";
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescription | null = null;
  onnegotiationneeded: (() => void) | null = null;
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
  ontrack: ((event: RTCTrackEvent) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  private descriptionId = 0;

  constructor(_configuration?: RTCConfiguration) {
    MockPeerConnection.instances.push(this);
  }

  addTransceiver(kind: string, init?: RTCRtpTransceiverInit): MockTransceiver {
    const transceiver = this.makeTransceiver(
      kind,
      init?.direction ?? "sendrecv",
    );
    this.transceivers.push(transceiver);
    return transceiver;
  }

  getTransceivers(): RTCRtpTransceiver[] {
    return this.transceivers as unknown as RTCRtpTransceiver[];
  }

  async setLocalDescription(
    description?: RTCSessionDescriptionInit,
  ): Promise<void> {
    const type =
      description?.type ??
      (this.signalingState === "have-remote-offer" ? "answer" : "offer");
    this.localDescription = {
      type,
      sdp: `${type}-${++this.descriptionId}`,
      toJSON: () => ({ type, sdp: this.localDescription?.sdp }),
    } as RTCSessionDescription;
    this.signalingState = type === "offer" ? "have-local-offer" : "stable";
  }

  async setRemoteDescription(
    description: RTCSessionDescriptionInit,
  ): Promise<void> {
    this.remoteDescription = {
      ...description,
      toJSON: () => description,
    } as RTCSessionDescription;
    if (description.type === "offer") {
      this.signalingState = "have-remote-offer";
      if (this.transceivers.length === 0) {
        this.transceivers.push(this.makeTransceiver("audio", "sendrecv"));
        this.transceivers.push(this.makeTransceiver("video", "sendrecv"));
      }
    } else {
      this.signalingState = "stable";
    }
  }

  async addIceCandidate(_candidate: RTCIceCandidateInit): Promise<void> {}

  close(): void {
    this.signalingState = "closed";
    this.connectionState = "closed";
  }

  makeTransceiver(
    kind: string,
    direction: RTCRtpTransceiverDirection,
  ): MockTransceiver {
    const sender: MockTransceiver["sender"] = {
      track: null,
      replaceTrack: async (track) => {
        sender.track = track;
      },
    };
    return {
      direction,
      sender,
      receiver: {
        track: new MockTrack(
          kind,
          `remote-${kind}-${this.transceivers.length}`,
        ) as unknown as FakeTrack,
      },
    };
  }
}

function createMesh(
  selfId: string,
  outgoing: Array<{ targetId: string; signal: RtcSignal }> = [],
) {
  const remoteStreams = new Map<string, MediaStream | null>();
  const mesh = new PeerMesh({
    iceServers: [],
    selfId,
    sendSignal: (targetId, signal) => outgoing.push({ targetId, signal }),
    onRemoteStream: (participantId, stream) =>
      remoteStreams.set(participantId, stream),
    onStateChange: () => undefined,
  });
  return { mesh, remoteStreams };
}

const savedPeerConnection = globalThis.RTCPeerConnection;
const savedMediaStream = globalThis.MediaStream;

test.beforeEach(() => {
  MockPeerConnection.instances = [];
  globalThis.RTCPeerConnection =
    MockPeerConnection as unknown as typeof RTCPeerConnection;
  globalThis.MediaStream = MockMediaStream as unknown as typeof MediaStream;
});

test.afterEach(() => {
  globalThis.RTCPeerConnection = savedPeerConnection;
  globalThis.MediaStream = savedMediaStream;
});

test("initiator offer and answerer attach local camera and microphone tracks", async () => {
  const signals: Array<{ targetId: string; signal: RtcSignal }> = [];
  const camera = new MockTrack("video", "camera");
  const microphone = new MockTrack("audio", "microphone");
  const initiator = createMesh("a", signals).mesh;
  const answerer = createMesh("b", signals).mesh;

  await initiator.setVideoTrack(camera as unknown as MediaStreamTrack);
  await initiator.setAudioTrack(microphone as unknown as MediaStreamTrack);
  initiator.ensurePeer("b");
  const initiatorConnection = MockPeerConnection.instances[0];
  initiatorConnection.onnegotiationneeded?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const offer = signals.find((entry) => entry.signal.type === "offer")?.signal;
  assert.ok(offer && offer.type === "offer");
  assert.equal(
    initiatorConnection.transceivers.find(
      (entry) => entry.receiver.track.kind === "video",
    )?.sender.track,
    camera,
  );
  assert.equal(
    initiatorConnection.transceivers.find(
      (entry) => entry.receiver.track.kind === "audio",
    )?.sender.track,
    microphone,
  );

  await answerer.setVideoTrack(
    new MockTrack("video", "answerer-camera") as unknown as MediaStreamTrack,
  );
  await answerer.setAudioTrack(
    new MockTrack(
      "audio",
      "answerer-microphone",
    ) as unknown as MediaStreamTrack,
  );
  await answerer.handleSignal("a", offer);
  const answerConnection = MockPeerConnection.instances[1];
  assert.equal(
    answerConnection.transceivers.find(
      (entry) => entry.receiver.track.kind === "video",
    )?.sender.track?.id,
    "answerer-camera",
  );
  assert.equal(
    answerConnection.transceivers.find(
      (entry) => entry.receiver.track.kind === "audio",
    )?.sender.track?.id,
    "answerer-microphone",
  );
  assert.ok(signals.some((entry) => entry.signal.type === "answer"));

  initiator.closeAll();
  answerer.closeAll();
});

test("video sender replaces screen share and restores camera without renegotiation", async () => {
  const camera = new MockTrack("video", "camera");
  const screen = new MockTrack("video", "screen");
  const { mesh } = createMesh("a");
  mesh.ensurePeer("b");
  const connection = MockPeerConnection.instances[0];
  await mesh.setVideoTrack(camera as unknown as MediaStreamTrack);
  const sender = connection.transceivers.find(
    (entry) => entry.receiver.track.kind === "video",
  )?.sender;
  assert.equal(sender?.track, camera);

  await mesh.setVideoTrack(screen as unknown as MediaStreamTrack);
  assert.equal(sender?.track, screen);
  await mesh.setVideoTrack(camera as unknown as MediaStreamTrack);
  assert.equal(sender?.track, camera);

  mesh.closeAll();
});

test("a dropped peer can be removed and negotiated again after reconnect", async () => {
  const outgoing: Array<{ targetId: string; signal: RtcSignal }> = [];
  const peerStates: RTCPeerConnectionState[] = [];
  const remoteStreams = new Map<string, MediaStream | null>();
  const mesh = new PeerMesh({
    iceServers: [],
    selfId: "a",
    sendSignal: (targetId, signal) => outgoing.push({ targetId, signal }),
    onRemoteStream: (participantId, stream) =>
      remoteStreams.set(participantId, stream),
    onStateChange: (_participantId, state) => peerStates.push(state),
  });
  mesh.ensurePeer("b");
  const firstConnection = MockPeerConnection.instances[0];
  mesh.removePeer("b");

  assert.equal(firstConnection.signalingState, "closed");
  assert.equal(remoteStreams.get("b"), null);
  assert.deepEqual(peerStates, ["disconnected"]);
  mesh.ensurePeer("b");
  assert.equal(MockPeerConnection.instances.length, 2);
  assert.equal(mesh.hasPeer("b"), true);
  assert.notEqual(MockPeerConnection.instances[1], firstConnection);

  mesh.closeAll();
});

test("remote video is exposed only while unmuted and live", async () => {
  const { mesh, remoteStreams } = createMesh("b");
  await mesh.handleSignal("a", { type: "offer", sdp: "remote-offer" });
  const connection = MockPeerConnection.instances[0];
  const remoteVideo = connection.transceivers.find(
    (entry) => entry.receiver.track.kind === "video",
  )?.receiver.track as FakeTrack;
  connection.ontrack?.({ track: remoteVideo } as unknown as RTCTrackEvent);
  assert.equal(remoteStreams.get("a"), null);

  remoteVideo.fire("unmute");
  const stream = remoteStreams.get("a");
  assert.ok(stream);
  assert.equal(stream.getVideoTracks().length, 1);

  remoteVideo.fire("mute");
  assert.equal(remoteStreams.get("a"), null);
  remoteVideo.fire("unmute");
  assert.equal(remoteStreams.get("a")?.getVideoTracks().length, 1);
  remoteVideo.fire("ended");
  assert.equal(remoteStreams.get("a"), null);

  mesh.closeAll();
});
