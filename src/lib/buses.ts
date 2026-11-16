"use client";

import type { ServerPayloads } from "@/lib/ws-protocol";
import type { PresenceEvent } from "./presence-events";

export type { PresenceEvent } from "./presence-events";

type Listener<T> = (event: T) => void;

interface BusOptions<T> {
  /**
   * Hold events that arrive while nothing is subscribed and deliver them to the
   * first listener. The server replays stored presence on file open, and that
   * replay can land before the editor subscribes.
   */
  bufferWhileUnobserved?: boolean;
  /**
   * Identity used to coalesce buffered events. Only the newest event for a key
   * is replayed, so a long unsubscribe cannot grow the buffer without bound and
   * stale cursor positions are never delivered.
   */
  bufferKey?: (event: T) => string | undefined;
  maxBufferedEvents?: number;
  shouldBuffer?: (event: T) => boolean;
  clearBuffered?: (event: T, buffered: T) => boolean;
}

function createBus<T>(options: BusOptions<T> = {}) {
  const { bufferWhileUnobserved = false } = options;
  const bufferKey = options.bufferKey;
  const shouldBuffer = options.shouldBuffer;
  const clearBuffered = options.clearBuffered;
  const maxBufferedEvents = options.maxBufferedEvents ?? 500;
  const listeners = new Set<Listener<T>>();
  const bufferedEvents: T[] = [];
  return {
    emit(event: T): void {
      if (clearBuffered) {
        for (let index = bufferedEvents.length - 1; index >= 0; index -= 1) {
          if (clearBuffered(event, bufferedEvents[index])) {
            bufferedEvents.splice(index, 1);
          }
        }
      }
      if (bufferWhileUnobserved && listeners.size === 0) {
        if (shouldBuffer && !shouldBuffer(event)) return;
        const key = bufferKey ? bufferKey(event) : undefined;
        if (key) {
          const existing = bufferedEvents.findIndex(
            (buffered) =>
              bufferKey !== undefined && bufferKey(buffered) === key,
          );
          if (existing >= 0) bufferedEvents.splice(existing, 1);
        }
        bufferedEvents.push(event);
        if (bufferedEvents.length > maxBufferedEvents) bufferedEvents.shift();
        return;
      }
      for (const listener of listeners) {
        try {
          listener(event);
        } catch (error) {
          // One bad consumer must not break the fan-out, but never hide it.
          console.error("[codesync] bus listener failed", error);
        }
      }
    },
    on(listener: Listener<T>): () => void {
      listeners.add(listener);
      if (bufferWhileUnobserved && bufferedEvents.length > 0) {
        const missedEvents = bufferedEvents.splice(0);
        for (const event of missedEvents) {
          try {
            listener(event);
          } catch (error) {
            console.error("[codesync] bus listener failed", error);
          }
        }
      }
      return () => listeners.delete(listener);
    },
    resetHistory(): void {
      bufferedEvents.length = 0;
    },
    clear(): void {
      listeners.clear();
      bufferedEvents.length = 0;
    },
  };
}

// Presence is a snapshot, not a stream: coalescing by participant/file/kind
// keeps only the newest state, which is also what the gateway replays.
export const presenceBus = createBus<PresenceEvent>({
  bufferWhileUnobserved: true,
  bufferKey: (event) =>
    "fileId" in event
      ? `${event.participantId}:${event.fileId}:${event.kind}`
      : undefined,
  shouldBuffer: (event) => "fileId" in event,
  clearBuffered: (event, buffered) => {
    if (event.kind === "clear-all") return true;
    return (
      event.kind === "clear-participant" &&
      "participantId" in buffered &&
      buffered.participantId === event.participantId
    );
  },
});
// WebRTC signals can arrive during the join-to-room transition, before the
// room route subscribes. Buffer only while there is no listener, and deliver
// each missed signal once; replaying handled signals breaks later peer meshes.
export const webrtcBus = createBus<ServerPayloads["webrtc_signal"]>({
  bufferWhileUnobserved: true,
});
// A transient socket drop keeps the participant in the room but invalidates
// the old peer connection. Rebuild it when that participant reconnects.
export const peerResetBus = createBus<string>();
export const fsRequestBus = createBus<ServerPayloads["fs_request"]>();
export const hostActionBus = createBus<ServerPayloads["host_action"]>();
export const yjsBus = createBus<ServerPayloads["yjs_sync"]>();
