/**
 * Temporary probe (not committed): connects two WebSocket clients to the
 * DEPLOYED CodeSync Worker and verifies the WebRTC signaling relay —
 * offer, answer, ICE candidate, and media_state round trips.
 */
import WebSocket from "ws";

const BASE = "https://codesync.sallydon164.workers.dev";
const ORIGIN = BASE;
const WS_URL = "wss://codesync.sallydon164.workers.dev/ws";

interface Step { name: string; ok: boolean; detail?: string }
const results: Step[] = [];
const step = (name: string, ok: boolean, detail?: string) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

function connect(key: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_URL}?room=${key}`, { origin: ORIGIN });
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
    setTimeout(() => reject(new Error("ws open timeout")), 15_000);
  });
}

interface ServerMsg {
  type: string;
  data: Record<string, unknown>;
}
function waitFor(
  ws: WebSocket,
  type: string,
  timeoutMs = 10_000,
): Promise<ServerMsg> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timeout waiting for ${type}`)),
      timeoutMs,
    );
    const onMessage = (raw: WebSocket.RawData): void => {
      try {
        const message = JSON.parse(String(raw)) as ServerMsg;
        if (message.type === type) {
          clearTimeout(timer);
          ws.off("message", onMessage);
          resolve(message);
        }
      } catch {
        // ignore non-JSON
      }
    };
    ws.on("message", onMessage);
  });
}

let msgId = 0;
function send(ws: WebSocket, type: string, data: unknown): void {
  ws.send(
    JSON.stringify({
      v: 1,
      id: `probe_${++msgId}`,
      type,
      ts: Date.now(),
      data,
    }),
  );
}

async function main(): Promise<void> {
  // 1. Create a room on the live deployment.
  const createResponse = await fetch(`${BASE}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hostName: "ProbeHost" }),
  });
  const created = (await createResponse.json()) as {
    roomKey?: string;
    hostToken?: string;
    error?: string;
  };
  if (!createResponse.ok || !created.roomKey) {
    throw new Error(`room create failed: ${JSON.stringify(created)}`);
  }
  const key = created.roomKey;
  step("room created on live worker", true, key);

  // 2. Host connects and joins with the host token.
  const hostWs = await connect(key);
  send(hostWs, "join_room", {
    roomKey: key,
    displayName: "ProbeHost",
    hostToken: created.hostToken,
    media: { mic: true, cam: false },
    client: { supportsFs: false, appVersion: "probe" },
  });
  const hostAdmitted = await waitFor(hostWs, "admitted");
  const hostId = (hostAdmitted.data.self as { id: string }).id;
  step("host joined", true, hostId);

  // 3. Guest connects and joins.
  const guestWs = await connect(key);
  send(guestWs, "join_room", {
    roomKey: key,
    displayName: "ProbeGuest",
    media: { mic: false, cam: false },
    client: { supportsFs: false, appVersion: "probe" },
  });
  const guestAdmitted = await waitFor(guestWs, "admitted");
  const guestId = (guestAdmitted.data.self as { id: string }).id;
  step("guest joined", true, guestId);

  // 4. Host → guest offer relay.
  const t0 = Date.now();
  send(hostWs, "webrtc_signal", {
    targetId: guestId,
    signal: { type: "offer", sdp: "v=0\r\no=- probe offer\r\ns=-\r\n" },
  });
  const offerAtGuest = await waitFor(guestWs, "webrtc_signal");
  step(
    "offer relayed host → guest",
    (offerAtGuest.data as { fromId?: string }).fromId === hostId,
    `${Date.now() - t0}ms`,
  );

  // 5. Guest → host answer relay.
  send(guestWs, "webrtc_signal", {
    targetId: hostId,
    signal: { type: "answer", sdp: "v=0\r\no=- probe answer\r\ns=-\r\n" },
  });
  const answerAtHost = await waitFor(hostWs, "webrtc_signal");
  step(
    "answer relayed guest → host",
    (answerAtHost.data as { fromId?: string }).fromId === guestId,
  );

  // 6. ICE candidate relay (the media-path payload).
  send(guestWs, "webrtc_signal", {
    targetId: hostId,
    signal: {
      type: "candidate",
      candidate: {
        candidate:
          "candidate:1 1 udp 2122260223 192.168.1.10 50001 typ host generation 0",
        sdpMid: "0",
        sdpMLineIndex: 0,
        usernameFragment: "probe",
      },
    },
  });
  const candidateAtHost = await waitFor(hostWs, "webrtc_signal");
  const candidate = (candidateAtHost.data as {
    signal: { type: string; candidate?: unknown };
  }).signal;
  step(
    "ice candidate relayed guest → host",
    candidate.type === "candidate" && candidate.candidate !== undefined,
  );

  // 7. media_state from the guest (no speak permission → expect FORBIDDEN
  //    error but still an authoritative participant_updated echo).
  send(guestWs, "media_state", { mic: true, cam: true, screen: false });
  const mediaEcho = await waitFor(guestWs, "participant_updated");
  const echoedSelf = mediaEcho.data.participant as {
    id: string;
    mic: boolean;
  };
  step(
    "guest media_state echoed without speak grant",
    echoedSelf.id === guestId && echoedSelf.mic === false,
    `mic=${echoedSelf.mic}`,
  );

  // 8. Host media_state with mic on → mic should stick.
  send(hostWs, "media_state", { mic: true, cam: false, screen: false });
  const hostEcho = await waitFor(hostWs, "participant_updated");
  const hostSelf = hostEcho.data.participant as { id: string; mic: boolean };
  step(
    "host media_state mic sticks",
    hostSelf.id === hostId && hostSelf.mic === true,
    `mic=${hostSelf.mic}`,
  );

  hostWs.close();
  guestWs.close();

  const failed = results.filter((r) => !r.ok);
  console.log(
    failed.length === 0
      ? `\nALL ${results.length} SIGNALING CHECKS PASSED on the live deployment`
      : `\n${failed.length} CHECK(S) FAILED`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error("probe failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
