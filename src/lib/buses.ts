"use client";

import type { ServerPayloads } from "@/lib/ws-protocol";
import type { PresenceEvent } from "./presence-events";

export type { PresenceEvent } from "./presence-events";

type Listener<T> = (event: T) => void;

function createBus<T>() {
  const listeners = new Set<Listener<T>>();
  return {
    emit(event: T): void {
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
      return () => listeners.delete(listener);
    },
    clear(): void {
      listeners.clear();
    },
  };
}

export const presenceBus = createBus<PresenceEvent>();
export const webrtcBus = createBus<ServerPayloads["webrtc_signal"]>();
export const fsRequestBus = createBus<ServerPayloads["fs_request"]>();
export const hostActionBus = createBus<ServerPayloads["host_action"]>();
export const yjsBus = createBus<ServerPayloads["yjs_sync"]>();
