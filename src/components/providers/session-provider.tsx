"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useParams, usePathname, useRouter } from "next/navigation";
import { toast } from "sonner";
import type {
  ClientPayloads,
  ClientType,
  ServerMessage,
} from "@/lib/ws-protocol";
import {
  RoomSocketClient,
  resolveWsUrl,
  type ConnectionStatus,
  type JoinCredentials,
} from "@/lib/socket/roomSocketClient";
import { useRoomStore } from "@/stores/room.store";
import { useWorkspaceStore } from "@/stores/workspace.store";
import { useMediaStore } from "@/stores/media.store";
import { useUiStore } from "@/stores/ui.store";
import { resetSessionState } from "@/stores/reset";
import { hasCapability } from "@/lib/acl";
import {
  fsRequestBus,
  hostActionBus,
  peerResetBus,
  presenceBus,
  webrtcBus,
  yjsBus,
} from "@/lib/buses";
import { toPresenceEvent } from "@/lib/presence-events";
import { ChatNotificationGate } from "@/lib/chat-notification";

type ConnectOptions = Partial<JoinCredentials> & {
  displayName?: string;
  /** The lobby is a guest surface; never claim the host identity there. */
  claimHost?: boolean;
};

interface SessionContextValue {
  status: ConnectionStatus;
  roomKey: string;
  connect(options?: ConnectOptions): boolean;
  send<K extends ClientType>(type: K, data: ClientPayloads[K]): void;
  disconnect(): void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

const NAME_KEY = "codesync:name";
const RT_PREFIX = "codesync:rt:";
const HOST_PREFIX = "codesync:host:";
const MEDIA_KEY = "codesync:media";
const SOCKET_NOT_CONNECTED_ERROR =
  "The session is not connected. Your action was not sent.";

function clearReconnectCredential(roomKey: string): void {
  if (roomKey) window.sessionStorage.removeItem(`${RT_PREFIX}${roomKey}`);
}

function normalizeRemovalReason(reason: string): string {
  const normalized = reason.trim();
  return /^removed by host\b/i.test(normalized)
    ? normalized
    : `Removed by host: ${normalized || "Removed by host"}`;
}

function readMediaPreference(): { mic: boolean; cam: boolean } {
  try {
    const raw = window.localStorage.getItem(MEDIA_KEY);
    if (!raw) return { mic: false, cam: false };
    const parsed = JSON.parse(raw) as { mic?: boolean; cam?: boolean };
    return { mic: Boolean(parsed.mic), cam: Boolean(parsed.cam) };
  } catch {
    return { mic: false, cam: false };
  }
}

function rememberName(name: string): void {
  window.localStorage.setItem(NAME_KEY, name);
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const params = useParams<{ key?: string | string[] }>();
  const router = useRouter();
  const pathname = usePathname();
  const roomKeyParam = params?.key;
  const roomKey = Array.isArray(roomKeyParam)
    ? (roomKeyParam[0] ?? "")
    : (roomKeyParam ?? "");

  const clientRef = useRef<RoomSocketClient | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const admittedRef = useRef(false);
  const admissionPendingRef = useRef(false);
  const hostFallbackRef = useRef(false);
  const chatNotificationGateRef = useRef(new ChatNotificationGate());
  const autoConnectedFor = useRef<string | null>(null);
  const previousRoomKey = useRef(roomKey);
  const routeRef = useRef({ roomKey, pathname });
  routeRef.current = { roomKey, pathname };
  const routerRef = useRef(router);
  routerRef.current = router;

  const send = useCallback(
    <K extends ClientType>(type: K, data: ClientPayloads[K]): void => {
      try {
        clientRef.current?.send(type, data);
      } catch (error) {
        // The transport may still be connecting when the server's admission
        // arrives. Any action in that admission window is not a genuine
        // disconnect and must not interrupt joining with a false error toast.
        if (
          admissionPendingRef.current &&
          !admittedRef.current &&
          error instanceof Error &&
          error.message === SOCKET_NOT_CONNECTED_ERROR
        ) {
          return;
        }
        toast.error(
          error instanceof Error
            ? error.message
            : "Could not send the WebSocket message",
        );
      }
    },
    [],
  );

  const handleMessage = useCallback(
    (message: ServerMessage) => {
      const room = useRoomStore.getState();
      const workspace = useWorkspaceStore.getState();
      const media = useMediaStore.getState();
      const ui = useUiStore.getState();
      const { roomKey: key, pathname: path } = routeRef.current;

      switch (message.type) {
        case "room_state": {
          room.applyRoomState(message.data);
          workspace.setFiles(message.data.files);
          workspace.setMode(
            message.data.room.workspaceMode,
            message.data.room.rootName,
          );
          media.setMicEnabled(message.data.self.mic);
          media.setCamEnabled(message.data.self.cam);
          media.setScreenSharing(message.data.self.screen);
          break;
        }
        case "admitted": {
          if (key)
            window.sessionStorage.setItem(
              `${RT_PREFIX}${key}`,
              message.data.reconnectToken,
            );
          room.setReconnectToken(message.data.reconnectToken);
          admittedRef.current = true;
          admissionPendingRef.current = false;
          hostFallbackRef.current = false;
          media.setMicEnabled(message.data.self.mic);
          media.setCamEnabled(message.data.self.cam);
          const firstAdmission = room.status !== "admitted";
          room.setStatus("admitted");
          if (path.startsWith("/join/") && key) {
            routerRef.current.replace(`/room/${key}`);
          }
          if (firstAdmission)
            toast.success(`You're in as ${message.data.self.name}`);
          break;
        }
        case "participant_joined": {
          room.upsertParticipant(message.data.participant);
          if (room.self && message.data.participant.id !== room.self.id) {
            toast(`${message.data.participant.name} joined`);
          }
          break;
        }
        case "participant_updated": {
          const previous = room.participants.find(
            (entry) => entry.id === message.data.participant.id,
          );
          const next = message.data.participant;
          room.upsertParticipant(next);
          if (previous && previous.state !== next.state) {
            peerResetBus.emit(next.id);
          }

          // A hand going up is a signal people should not have to stare at the
          // rail to notice; announce it once, and let managers grant the floor
          // straight from the toast.
          if (next.handRaised && !previous?.handRaised) {
            if (next.id === room.self?.id) {
              toast.success("Hand raised", {
                description: "Everyone in the room can see it.",
              });
            } else if (hasCapability(room.self, "manage_media")) {
              toast.info(`${next.name} raised their hand`, {
                description: "They are waiting for the floor.",
                action: {
                  label: "Grant speak",
                  onClick: () =>
                    send("host_action", {
                      action: "grant_speak",
                      targetId: next.id,
                    }),
                },
                duration: 12_000,
              });
            } else {
              toast(`${next.name} raised their hand`);
            }
          }

          if (next.id === room.self?.id) {
            if (next.mic !== media.micEnabled) {
              media.setMicEnabled(next.mic);
            }
            if (next.cam !== media.camEnabled) {
              media.setCamEnabled(next.cam);
            }
          }
          break;
        }
        case "participant_left": {
          const leaving = room.participants.find(
            (p) => p.id === message.data.participantId,
          );
          presenceBus.emit({
            kind: "clear-participant",
            participantId: message.data.participantId,
          });
          const transientDrop = message.data.reason === "dropped";
          if (transientDrop) {
            peerResetBus.emit(message.data.participantId);
          }
          // A socket drop removes the person from the live roster. Their seat
          // survives on the server for a reconnect, but keeping the ghost in
          // the UI produced duplicate entries — especially a stale HOST.
          room.removeParticipant(message.data.participantId);
          media.removePeer(message.data.participantId);
          if (message.data.participantId === room.self?.id) {
            // A dropped socket is recoverable; explicit removal is terminal.
            if (message.data.reason !== "dropped")
              clearReconnectCredential(key);
          }
          if (
            leaving &&
            message.data.reason === "kicked" &&
            message.data.participantId !== room.self?.id
          ) {
            toast(`${leaving.name} was removed`);
          } else if (leaving && message.data.reason === "left") {
            toast(`${leaving.name} left`);
          }
          // A transient socket drop is not a participant leaving. Suppress the
          // announcement; a successful reconnect is represented by the server
          // as participant_updated rather than another join.
          break;
        }
        case "permission_changed": {
          // A demoted host must not keep using the old bearer credential.
          if (
            message.data.participantId === room.self?.id &&
            message.data.role !== "HOST"
          ) {
            window.localStorage.removeItem(`${HOST_PREFIX}${key}`);
          }
          room.applyPermission(message.data);
          if (message.data.role !== "HOST" && !message.data.canEdit) {
            presenceBus.emit({
              kind: "clear-participant",
              participantId: message.data.participantId,
            });
          }
          if (room.self?.id === message.data.participantId) {
            const access = message.data.canEdit
              ? "You can edit files."
              : "Files are read-only for you.";
            toast.message("Permissions updated", {
              description: `Role: ${message.data.role.toLowerCase()}. ${access}`,
            });
          }
          break;
        }
        case "waiting_room": {
          const previous = room.waiting.length;
          room.setWaiting(message.data.waiting);
          if (
            message.data.waiting.length > previous &&
            message.data.waiting.length > 0 &&
            (room.self?.role === "HOST" || room.self?.role === "CO_HOST")
          ) {
            toast.info("Someone is waiting to join", {
              description:
                message.data.waiting[message.data.waiting.length - 1]?.name,
            });
          }
          break;
        }
        case "chat_message": {
          const chatMessage = message.data.message;
          const notificationScope = `${key}:${room.sessionEpoch}`;
          const notification = chatNotificationGateRef.current.notificationFor(
            chatMessage,
            room.self?.id ?? null,
            notificationScope,
          );
          const isIncoming = chatMessage.participantId !== room.self?.id;
          room.addChatMessage(chatMessage);
          if (isIncoming) {
            // Only treat chat as read when the rail is physically open on the
            // chat tab. A hidden rail (desktop toggle or compact drawer) must
            // still collect unread messages.
            if (ui.sidePanelTab !== "chat" || !ui.railVisible)
              ui.incrementUnread();
            if (notification) {
              toast(notification.title, {
                description: notification.description,
                duration: 5000,
              });
            }
          }
          break;
        }
        case "file_tree": {
          workspace.setFiles(message.data.files);
          break;
        }
        case "workspace_reset": {
          workspace.reset(
            message.data.files,
            message.data.mode,
            message.data.rootName,
          );
          room.setRoomPatch({
            workspaceMode: message.data.mode,
            rootName: message.data.rootName,
          });
          toast.message("Workspace reloaded from the host disk");
          break;
        }
        case "workspace_save": {
          const save = message.data;
          workspace.setSaveState(save);
          if (save.phase === "success") {
            toast.success(
              save.mode === "local-fs"
                ? `Saved ${save.saved} ${save.saved === 1 ? "file" : "files"} to disk`
                : "Workspace saved to the session",
            );
          } else if (save.phase === "partial") {
            toast.warning(
              `Saved ${save.saved} of ${save.total} files; ${save.failed} failed`,
              {
                description: save.failures
                  .slice(0, 3)
                  .map((failure) => `${failure.path}: ${failure.error}`)
                  .join(" · "),
                duration: 8000,
              },
            );
          } else if (save.phase === "empty") {
            toast.info("There are no loaded files to save");
          } else if (save.phase === "failed") {
            toast.error("The workspace could not be saved", {
              description:
                save.failures[0]?.error ?? "The host folder did not respond",
            });
          }
          break;
        }
        case "file_changed": {
          const { op, path: changedPath, toPath, meta } = message.data;
          if (op === "delete") {
            const removedActive = workspace.tabs.some(
              (tab) =>
                tab.fileId === workspace.activeFileId &&
                (tab.path === changedPath ||
                  tab.path.startsWith(`${changedPath}/`)),
            );
            workspace.removePath(changedPath);
            if (removedActive) {
              toast.warning("The file you were viewing was deleted", {
                description: changedPath,
              });
            }
          } else if (op === "rename" || op === "move")
            workspace.movePath(changedPath, toPath ?? changedPath, meta);
          else if (meta) workspace.upsertMeta(meta);
          break;
        }
        case "cursor":
        case "selection":
        case "viewport": {
          presenceBus.emit(toPresenceEvent(message));
          break;
        }
        case "webrtc_signal": {
          webrtcBus.emit(message.data);
          break;
        }
        case "yjs_sync": {
          yjsBus.emit(message.data);
          break;
        }
        case "fs_request": {
          fsRequestBus.emit(message.data);
          break;
        }
        case "permission_request": {
          const { participantId, name, kind } = message.data;
          toast.info(`${name} is requesting ${kind} access`, {
            action: {
              label: "Grant",
              onClick: () =>
                send("host_action", {
                  action: kind === "edit" ? "grant_edit" : "grant_speak",
                  targetId: participantId,
                }),
            },
            duration: 12_000,
          });
          break;
        }
        case "host_action": {
          hostActionBus.emit(message.data);
          const { action, payload, targetId } = message.data;
          if (action === "lock_room" || action === "unlock_room") {
            room.setRoomPatch({
              status: action === "lock_room" ? "locked" : "open",
            });
            if (action === "lock_room")
              toast.warning("The host locked the room");
          }
          if (
            action === "toggle_admit_mode" &&
            typeof payload?.admitMode === "string"
          ) {
            room.setRoomPatch({
              admitMode: payload.admitMode === "manual" ? "manual" : "auto",
            });
          }
          if (
            action === "toggle_screen_share" &&
            typeof payload?.allowGuestScreenShare === "boolean"
          ) {
            room.setRoomPatch({
              allowGuestScreenShare: payload.allowGuestScreenShare,
            });
          }
          if (action === "mute" && targetId === room.self?.id) {
            media.setMicEnabled(false);
            toast.warning("The host muted you");
          }
          if (action === "ask_unmute" && targetId === room.self?.id) {
            toast.info("The host asked you to unmute");
          }
          if (action === "transfer_host") {
            // The server sends the replacement host token only to the new
            // host. Persist it so a later reconnect can reclaim the role.
            if (
              action === "transfer_host" &&
              payload?.hostParticipantId === room.self?.id &&
              typeof payload?.hostToken === "string"
            ) {
              window.localStorage.setItem(
                `${HOST_PREFIX}${key}`,
                payload.hostToken,
              );
              clientRef.current?.updateCredentials({
                hostToken: payload.hostToken,
              });
              toast.message("You are now the host");
            } else {
              toast.message("Host controls transferred");
            }
          }
          break;
        }
        case "reaction": {
          // Reactions are broadcast to everyone; don't echo the sender's own
          // reaction back to them.
          if (message.data.participantId === room.self?.id) break;
          const author = room.participants.find(
            (p) => p.id === message.data.participantId,
          );
          toast(`${author?.name ?? "Someone"} ${message.data.emoji}`, {
            duration: 1800,
          });
          break;
        }
        case "denied": {
          room.setStatus("denied");
          room.setError(message.data.reason);
          clearReconnectCredential(key);
          toast.error(message.data.reason);
          routerRef.current.replace("/");
          break;
        }
        case "kicked": {
          room.setStatus("kicked");
          room.setError(message.data.reason);
          clearReconnectCredential(key);
          toast.error(normalizeRemovalReason(message.data.reason));
          routerRef.current.replace("/");
          break;
        }
        case "room_ended": {
          clientRef.current?.stopReconnecting();
          room.setStatus("ended");
          room.setError("The host ended this session");
          clearReconnectCredential(key);
          // One id keeps duplicate broadcasts / a follow-up ROOM_ENDED join
          // error from stacking the same toast.
          toast.message("The host ended this session", { id: "room-ended" });
          break;
        }
        case "error": {
          if (message.data.code === "ROOM_ENDED") {
            clientRef.current?.stopReconnecting();
            room.setStatus("ended");
            room.setError(message.data.message);
            clearReconnectCredential(key);
            toast.message(message.data.message, { id: "room-ended" });
            break;
          }
          // A stale reconnect token can outlive its server-side credential
          // while this browser still holds the durable host token. Retry the
          // join as the host before surfacing a lockout.
          if (
            message.data.code === "UNAUTHENTICATED" &&
            key &&
            !hostFallbackRef.current
          ) {
            const staleReconnect = window.sessionStorage.getItem(
              `${RT_PREFIX}${key}`,
            );
            const storedHostToken = window.localStorage.getItem(
              `${HOST_PREFIX}${key}`,
            );
            if (staleReconnect && storedHostToken) {
              hostFallbackRef.current = true;
              clearReconnectCredential(key);
              const retried = clientRef.current?.retryJoin({
                reconnectToken: undefined,
                hostToken: storedHostToken,
              });
              if (retried) {
                room.setStatus("joining");
                room.setError(null);
                break;
              }
            }
          }
          toast.error(message.data.message, {
            id: `${message.data.code}:${message.data.message}`,
          });
          if (
            message.data.code === "FORBIDDEN" &&
            message.data.message ===
              "This participant can no longer rejoin the session"
          ) {
            // The participant was removed or otherwise lost terminal access.
            // Clear the stale credential so the lobby can offer a clean join.
            clearReconnectCredential(key);
            room.setStatus("error");
            room.setError(message.data.message);
          } else if (
            message.data.code === "ROOM_NOT_FOUND" ||
            message.data.code === "ROOM_LOCKED" ||
            message.data.code === "PARTICIPANT_LIMIT" ||
            message.data.code === "UNAUTHENTICATED"
          ) {
            room.setStatus("error");
            room.setError(message.data.message);
          }
          break;
        }
        default:
          break;
      }
    },
    [send],
  );

  const messageRef = useRef(handleMessage);
  messageRef.current = handleMessage;

  useEffect(() => {
    const client = new RoomSocketClient(resolveWsUrl(), {
      onStatus: (next) => {
        admittedRef.current = false;
        if (next === "open") {
          // Every socket opening starts a new join handshake, including an
          // automatic reconnect after a transient network loss.
          admissionPendingRef.current = true;
        } else if (next === "closed" || next === "idle") {
          admissionPendingRef.current = false;
        }
        if (next !== "open" && useRoomStore.getState().status === "admitted") {
          useRoomStore.getState().setStatus("joining");
        }
        setStatus(next);
        useRoomStore.getState().setConnection(next);
      },
      onMessage: (message) => messageRef.current(message),
    });
    clientRef.current = client;
    return () => {
      client.disconnect();
      clientRef.current = null;
      resetSessionState();
      // React StrictMode mounts, tears down and remounts effects in dev. The
      // client is recreated on remount, so the auto-connect guard must reset
      // too or the new client would never join a room.
      autoConnectedFor.current = null;
    };
  }, []);

  const connect = useCallback(
    (options?: ConnectOptions): boolean => {
      if (!roomKey) return false;
      const stored = window.localStorage.getItem(NAME_KEY) ?? "";
      const displayName = (options?.displayName ?? stored).trim().slice(0, 48);
      if (!displayName) return false;
      rememberName(displayName);

      const preferences = readMediaPreference();
      const reconnectToken =
        window.sessionStorage.getItem(`${RT_PREFIX}${roomKey}`) ?? undefined;
      // A tab that already holds a reconnect token must resume its own
      // participant. Falling back to the shared host token here is what let a
      // second tab evict the host and start a reconnect tug-of-war. Joining from
      // the lobby is always a guest join, even in the host's own browser, so a
      // previewed or self-opened invite link cannot steal the host identity.
      const hostToken =
        options?.claimHost === false || reconnectToken
          ? undefined
          : (window.localStorage.getItem(`${HOST_PREFIX}${roomKey}`) ??
            undefined);
      const credentials: JoinCredentials = {
        roomKey,
        displayName,
        hostToken,
        reconnectToken,
        mic: options?.mic ?? preferences.mic,
        cam: options?.cam ?? preferences.cam,
      };
      admissionPendingRef.current = true;
      admittedRef.current = false;
      hostFallbackRef.current = false;
      clientRef.current?.connect(credentials);
      return true;
    },
    [roomKey],
  );

  const disconnect = useCallback(() => {
    clientRef.current?.disconnect();
    webrtcBus.resetHistory();
    // An explicit disconnect is a terminal leave. Socket drops that happen on
    // their own never call this and keep the credential for reconnection.
    clearReconnectCredential(roomKey);
    resetSessionState();
  }, [roomKey]);

  useEffect(() => {
    if (previousRoomKey.current !== roomKey) {
      clientRef.current?.disconnect();
      webrtcBus.resetHistory();
      resetSessionState();
      autoConnectedFor.current = null;
      previousRoomKey.current = roomKey;
    }
  }, [roomKey]);

  useEffect(() => {
    if (!roomKey) return;
    if (!pathname.startsWith("/room/")) return;
    const client = clientRef.current;
    // Only skip when this exact client is already attached to this room;
    // transient statuses are not enough (StrictMode remounts reset them).
    if (
      autoConnectedFor.current === roomKey &&
      client?.getRoomKey() === roomKey
    )
      return;
    const stored = window.localStorage.getItem(NAME_KEY);
    if (!stored) {
      router.replace(`/join/${roomKey}`);
      return;
    }
    autoConnectedFor.current = roomKey;
    connect();
  }, [connect, pathname, roomKey, router]);

  useEffect(() => {
    const onVisible = (): void => {
      if (document.visibilityState === "visible")
        clientRef.current?.reconnectNow();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  const value = useMemo<SessionContextValue>(
    () => ({ status, roomKey, connect, send, disconnect }),
    [status, roomKey, connect, send, disconnect],
  );

  return (
    <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
  );
}

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (!context)
    throw new Error("useSession must be used inside SessionProvider");
  return context;
}
