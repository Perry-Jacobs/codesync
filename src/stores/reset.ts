"use client";

import { useMediaStore } from "./media.store";
import { useRoomStore } from "./room.store";
import { useUiStore } from "./ui.store";
import { useWorkspaceStore } from "./workspace.store";

/** Resets every client-side store while preserving shared bus subscriptions. */
export function resetSessionState(): void {
  useRoomStore.getState().reset();
  useMediaStore.getState().reset();
  useWorkspaceStore.getState().clear();
  useUiStore.getState().reset();
}
