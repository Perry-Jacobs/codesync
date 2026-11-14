"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { del, get, set } from "idb-keyval";
import { toast } from "sonner";
import { useSession } from "@/components/providers/session-provider";
import { fsRequestBus } from "@/lib/buses";
import {
  buildSnapshot,
  ensurePermission,
  pickWorkspaceFolder,
  supportsFileSystemAccess,
} from "@/lib/fs/hostFs";
import { serveFsRequest } from "@/lib/fs/serveRequest";
import type { DirHandleLike } from "@/lib/fs/types";
import { useRoomStore } from "@/stores/room.store";
import { useWorkspaceStore } from "@/stores/workspace.store";

export interface HostWorkspaceApi {
  supported: boolean;
  connected: boolean;
  rootName: string | null;
  /** Folder remembered from a previous visit whose permission lapsed. */
  savedName: string | null;
  busy: boolean;
  connect(): Promise<void>;
  reconnect(): Promise<void>;
  disconnect(): Promise<void>;
}

const storageKey = (roomKey: string): string => `codesync:dir:${roomKey}`;

/**
 * Host-only filesystem bridge. The host's chosen folder is the source of
 * truth: the gateway sends fs_request frames and this hook answers them.
 */
export function useHostWorkspace(roomKey: string): HostWorkspaceApi {
  const { send } = useSession();
  const self = useRoomStore((state) => state.self);
  const sessionEpoch = useRoomStore((state) => state.sessionEpoch);
  const hostFolderConnected = useWorkspaceStore(
    (state) => state.hostFolderConnected,
  );
  const setHostFolderConnected = useWorkspaceStore(
    (state) => state.setHostFolderConnected,
  );
  const isHost = self?.role === "HOST";

  const [rootName, setRootName] = useState<string | null>(null);
  const [savedName, setSavedName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<DirHandleLike | null>(null);
  const savedRef = useRef<DirHandleLike | null>(null);
  const rootScopeRef = useRef<string | null>(null);
  const scope = `${roomKey}:${sessionEpoch}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  const attach = useCallback(
    async (handle: DirHandleLike, prompt: boolean): Promise<boolean> => {
      const attachScope = scopeRef.current;
      const granted = await ensurePermission(handle, "readwrite", prompt);
      if (attachScope !== scopeRef.current) return false;
      if (!granted) {
        toast.error("Folder access was not granted");
        return false;
      }
      const snapshot = await buildSnapshot(handle);
      if (attachScope !== scopeRef.current) return false;
      rootRef.current = handle;
      rootScopeRef.current = attachScope;
      savedRef.current = handle;
      setRootName(handle.name);
      setSavedName(handle.name);
      setHostFolderConnected(true);
      await set(storageKey(roomKey), handle);
      if (attachScope !== scopeRef.current) return false;
      send("fs_bridge_attach", {
        connected: true,
        rootName: handle.name,
        snapshot,
      });
      return true;
    },
    [roomKey, send, setHostFolderConnected],
  );

  const connect = useCallback(async (): Promise<void> => {
    if (!isHost) return;
    if (!supportsFileSystemAccess()) {
      toast.error("Folder access needs a Chromium browser (Chrome or Edge)");
      return;
    }
    setBusy(true);
    try {
      const handle = await pickWorkspaceFolder();
      if (!handle) return;
      const ok = await attach(handle, true);
      if (ok) {
        toast.success(
          `Connected “${handle.name}” — guests edit the real files`,
        );
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not read that folder",
      );
    } finally {
      setBusy(false);
    }
  }, [attach, isHost]);

  const reconnect = useCallback(async (): Promise<void> => {
    setBusy(true);
    try {
      const handle =
        savedRef.current ??
        ((await get(storageKey(roomKey))) as DirHandleLike | undefined);
      if (!handle) {
        toast.error("No saved folder is available to reconnect");
        return;
      }
      savedRef.current = handle;
      const ok = await attach(handle, true);
      if (ok) toast.success(`Reconnected “${handle.name}”`);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not reconnect that folder",
      );
    } finally {
      setBusy(false);
    }
  }, [attach, roomKey]);

  const disconnect = useCallback(async (): Promise<void> => {
    rootRef.current = null;
    rootScopeRef.current = null;
    savedRef.current = null;
    setRootName(null);
    setSavedName(null);
    setHostFolderConnected(false);
    await del(storageKey(roomKey));
    send("fs_bridge_attach", { connected: false, rootName: "", snapshot: [] });
    toast.message(
      "Local folder disconnected — the workspace stays in the room",
    );
  }, [roomKey, send, setHostFolderConnected]);

  // Restore a previously granted folder (permission may have expired).
  useEffect(() => {
    if (!isHost || !supportsFileSystemAccess()) return;
    let cancelled = false;
    void (async () => {
      try {
        const stored = (await get(storageKey(roomKey))) as
          DirHandleLike | undefined;
        if (!stored || cancelled) return;
        const granted = await ensurePermission(stored, "readwrite", false);
        if (cancelled) return;
        savedRef.current = stored;
        if (!granted) {
          setSavedName(stored.name);
          return;
        }
        await attach(stored, false);
      } catch {
        // A stale IndexedDB handle should never break the room.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [attach, isHost, roomKey]);

  // Never let a folder handle cross a room/session boundary.
  useEffect(() => {
    rootRef.current = null;
    rootScopeRef.current = null;
    savedRef.current = null;
    setRootName(null);
    setSavedName(null);
    setHostFolderConnected(false);
  }, [roomKey, sessionEpoch, setHostFolderConnected]);

  // Answer disk requests from the gateway.
  useEffect(() => {
    if (!isHost) return;
    return fsRequestBus.on((request) => {
      if (rootScopeRef.current !== scopeRef.current) return;
      void serveFsRequest(rootRef.current, request, send);
    });
  }, [isHost, send]);

  return {
    supported: supportsFileSystemAccess(),
    connected: hostFolderConnected && rootName !== null,
    rootName,
    savedName,
    busy,
    connect,
    reconnect,
    disconnect,
  };
}
