"use client";

import { useCallback } from "react";
import { nanoid } from "nanoid";
import { toast } from "sonner";
import { useSession } from "@/components/providers/session-provider";
import type { HostWorkspaceApi } from "@/hooks/useHostWorkspace";
import { hasCapability } from "@/lib/acl";
import { useRoomStore } from "@/stores/room.store";
import { useWorkspaceStore } from "@/stores/workspace.store";

/** Starts one host-scoped save operation and keeps optimistic UI in sync. */
export function useSaveWorkspace(host: HostWorkspaceApi) {
  const { send } = useSession();
  const self = useRoomStore((state) => state.self);
  const room = useRoomStore((state) => state.room);
  const setSaveState = useWorkspaceStore((state) => state.setSaveState);

  return useCallback((): void => {
    if (!hasCapability(self, "save_workspace")) {
      toast.warning("Only the host can save the workspace");
      return;
    }
    if (room?.workspaceMode === "local-fs" && !host.connected) {
      toast.warning("Reconnect your local folder to save to disk");
      return;
    }

    const operationId = `save_${nanoid(12)}`;
    setSaveState({
      phase: "saving",
      operationId,
      total: 0,
      saved: 0,
      failed: 0,
      failures: [],
    });
    send("host_action", {
      action: "save_workspace",
      payload: { operationId },
    });
  }, [host.connected, room?.workspaceMode, self, send, setSaveState]);
}
