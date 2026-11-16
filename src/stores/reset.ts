"use client";

import { useMediaStore } from "./media.store";
import { useRoomStore } from "./room.store";
import { useUiStore } from "./ui.store";
import { useWorkspaceStore } from "./workspace.store";
import { presenceBus } from "@/lib/buses";

/** Resets every client-side store while preserving shared bus subscriptions. */
export function resetSessionState(): void {
  presenceBus.emit({ kind: "clear-all" });
  useRoomStore.getState().reset();
  useMediaStore.getState().reset();
  useWorkspaceStore.getState().clear();
  useUiStore.getState().reset();
}
