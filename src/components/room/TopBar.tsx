"use client";

import { useEffect, useState } from "react";
import {
  ChevronDown,
  Copy,
  DoorOpen,
  HardDrive,
  Link2,
  Lock,
  MonitorUp,
  Moon,
  PanelLeft,
  PanelRight,
  Save,
  ShieldCheck,
  Sun,
  Unlock,
  UserCheck,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/components/providers/session-provider";
import { useTheme } from "@/components/providers/theme-provider";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { HostWorkspaceApi } from "@/hooks/useHostWorkspace";
import { useSaveWorkspace } from "@/hooks/useSaveWorkspace";
import { canEndSession, hasCapability } from "@/lib/acl";
import { cn } from "@/lib/utils";
import { useRoomStore } from "@/stores/room.store";
import { useUiStore } from "@/stores/ui.store";
import { useWorkspaceStore } from "@/stores/workspace.store";

interface TopBarProps {
  roomKey: string;
  host: HostWorkspaceApi;
  onToggleSidebar(): void;
  onTogglePeople(): void;
}

async function copyText(value: string, message: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    toast.success(message);
  } catch {
    toast.error("Your browser blocked clipboard access");
  }
}

export function TopBar({
  roomKey,
  host,
  onToggleSidebar,
  onTogglePeople,
}: TopBarProps) {
  const { send } = useSession();
  const { theme, toggle } = useTheme();
  const room = useRoomStore((state) => state.room);
  const self = useRoomStore((state) => state.self);
  const participants = useRoomStore((state) => state.participants);
  const waiting = useRoomStore((state) => state.waiting);
  const connection = useRoomStore((state) => state.connection);
  const sidebarOpen = useUiStore((state) => state.sidebarOpen);
  const railOpen = useUiStore((state) => state.railOpen);
  const activeFileId = useWorkspaceStore((state) => state.activeFileId);
  const files = useWorkspaceStore((state) => state.files);
  const save = useWorkspaceStore((state) => state.save);

  const saveWorkspace = useSaveWorkspace(host);
  const [endOpen, setEndOpen] = useState(false);
  const [origin, setOrigin] = useState("");

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const isHost = self?.role === "HOST";
  const canAdmit = hasCapability(self, "admit");
  const canManageRoles = hasCapability(self, "manage_roles");
  const canManageMedia = hasCapability(self, "manage_media");
  const canLock = hasCapability(self, "lock_room");
  const canSaveWorkspace = hasCapability(self, "save_workspace");
  const locked = room?.status === "locked";
  const inviteUrl = origin ? `${origin}/join/${roomKey}` : "";

  const folderLabel = host.connected
    ? (host.rootName ?? "Local folder")
    : host.savedName
      ? `Reconnect ${host.savedName}`
      : "Connect folder";

  const connectionTone =
    connection === "open"
      ? "bg-emerald-500"
      : connection === "reconnecting" || connection === "connecting"
        ? "bg-amber-400"
        : "bg-rose-500";
  const connectionLabel =
    connection === "open"
      ? "Live"
      : connection === "reconnecting" || connection === "connecting"
        ? "Reconnecting"
        : "Offline";

  const activePath =
    files.find((entry) => entry.fileId === activeFileId)?.path ??
    "no file open";

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-muted/40 px-2 sm:h-12 sm:px-3">
      <div className="flex min-w-0 flex-1 flex-col justify-center">
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="min-w-0 truncate text-[15px] font-semibold leading-tight text-foreground">
            {room?.title ?? "CodeSync session"}
          </h1>
          {locked ? (
            <span className="hidden shrink-0 items-center gap-1 text-[10px] font-medium text-amber-500 sm:flex">
              <Lock className="h-3 w-3" /> Locked
            </span>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => void copyText(roomKey, "Session key copied")}
          className="hidden min-w-0 items-center gap-1.5 text-left text-[11px] text-muted-foreground transition-colors hover:text-foreground sm:flex"
          aria-label="Copy session key"
        >
          <span className="shrink-0 font-mono">{roomKey}</span>
          <span className="shrink-0 opacity-50">·</span>
          <span className="truncate">{activePath}</span>
          <Copy className="h-3 w-3 shrink-0 opacity-60" />
        </button>
      </div>

      <span
        className={cn(
          "flex shrink-0 items-center gap-1.5 text-[11px] font-medium",
          connection === "open" ? "text-emerald-500" : "text-muted-foreground",
        )}
        title={`${connectionLabel} · ${participants.length} participants`}
      >
        <span className={cn("h-1.5 w-1.5 rounded-full", connectionTone)} />
        <span className="hidden sm:inline">{connectionLabel}</span>
        <Users className="h-3 w-3" /> {participants.length}
      </span>

      <div className="flex items-center gap-0.5 border-l border-border pl-2">
        {isHost ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={host.connected ? "secondary" : "outline"}
                size="sm"
                className="hidden h-7 gap-1.5 px-2 text-[11px] md:inline-flex"
                disabled={host.busy}
                onClick={() => {
                  if (host.connected) void host.disconnect();
                  else if (host.savedName) void host.reconnect();
                  else void host.connect();
                }}
              >
                <HardDrive
                  className={cn(
                    "h-3 w-3",
                    host.connected && "text-emerald-400",
                  )}
                />
                <span className="max-w-[130px] truncate">{folderLabel}</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {host.supported
                ? "Guests edit your real files; changes are saved back to disk"
                : "Local folders need Chrome or Edge"}
            </TooltipContent>
          </Tooltip>
        ) : null}

        {canSaveWorkspace ? (
          <Button
            variant="ghost"
            size="sm"
            className="hidden h-7 gap-1 px-2 text-[11px] sm:inline-flex"
            onClick={saveWorkspace}
            disabled={save.phase === "saving"}
          >
            <Save className="h-3 w-3" />
            {save.phase === "saving"
              ? "Saving…"
              : save.phase === "partial"
                ? `${save.failed} failed`
                : save.phase === "failed"
                  ? "Save failed"
                  : "Save"}
          </Button>
        ) : null}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1 px-2 text-[10px]"
            >
              <ShieldCheck className="h-3 w-3" />
              <span className="hidden sm:inline">Invite</span>
              <ChevronDown className="hidden h-3 w-3 sm:block" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuLabel className="font-mono text-[10px]">
              {roomKey}
            </DropdownMenuLabel>
            <DropdownMenuItem
              onSelect={() => void copyText(roomKey, "Session key copied")}
            >
              <Copy /> Copy session key
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => {
                if (!inviteUrl) return;
                void copyText(inviteUrl, "Invite link copied");
              }}
            >
              <Link2 /> Copy invite link
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <a
                href={`/join/${roomKey}?preview=1`}
                target="_blank"
                rel="noreferrer"
              >
                <DoorOpen /> Open lobby preview
              </a>
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => {
                void copyText(
                  `${room?.title ?? "CodeSync"} — join with ${roomKey} at ${inviteUrl}`,
                  "Invitation copied",
                );
              }}
            >
              <Users /> Copy text invitation
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {canAdmit ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-[10px]"
            onClick={() => send("host_action", { action: "admit_all" })}
            disabled={waiting.length === 0}
          >
            <UserCheck className="h-3 w-3" />
            {waiting.length > 0 ? `${waiting.length}` : "0"}
          </Button>
        ) : null}

        {canAdmit || canManageRoles || canManageMedia || canLock ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1 px-2 text-[10px]"
              >
                <ShieldCheck className="h-3 w-3" />
                <span className="hidden sm:inline">Host</span>
                <ChevronDown className="hidden h-3 w-3 sm:block" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuLabel>Session controls</DropdownMenuLabel>
              <DropdownMenuItem
                disabled={!canLock}
                onSelect={() =>
                  send("host_action", {
                    action: locked ? "unlock_room" : "lock_room",
                  })
                }
              >
                {locked ? <Unlock /> : <Lock />}
                {locked ? "Unlock the room" : "Lock the room"}
              </DropdownMenuItem>
              <DropdownMenuCheckboxItem
                checked={room?.admitMode === "manual"}
                disabled={!canAdmit}
                onCheckedChange={() =>
                  send("host_action", { action: "toggle_admit_mode" })
                }
              >
                Manual waiting room
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={room?.allowGuestScreenShare ?? false}
                disabled={!canManageMedia}
                onCheckedChange={() =>
                  send("host_action", { action: "toggle_screen_share" })
                }
              >
                <MonitorUp /> Guests may share screens
              </DropdownMenuCheckboxItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={!canSaveWorkspace || save.phase === "saving"}
                onSelect={saveWorkspace}
              >
                <Save />{" "}
                {save.phase === "saving"
                  ? "Saving workspace…"
                  : "Save workspace"}
              </DropdownMenuItem>
              {isHost ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    onSelect={() => setEndOpen(true)}
                  >
                    <DoorOpen /> End session…
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}

        <div className="mx-1 hidden h-5 w-px bg-border sm:block" />

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant={sidebarOpen ? "secondary" : "ghost"}
              size="icon-sm"
              className="h-7 w-7"
              onClick={onToggleSidebar}
              aria-label="Toggle file tree (Ctrl+B)"
            >
              <PanelLeft className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>File tree · Ctrl/Cmd+B</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant={railOpen ? "secondary" : "ghost"}
              size="icon-sm"
              className="relative h-7 w-7"
              onClick={onTogglePeople}
              aria-label="Toggle people and chat"
            >
              <PanelRight className="h-3.5 w-3.5" />
              <span className="absolute -right-0.5 -top-0.5 rounded-full bg-primary px-1 text-[8px] font-semibold text-primary-foreground">
                {participants.length}
              </span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>People &amp; chat</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="h-7 w-7"
              onClick={toggle}
              aria-label="Toggle theme"
            >
              {theme === "dark" ? (
                <Sun className="h-3.5 w-3.5" />
              ) : (
                <Moon className="h-3.5 w-3.5" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {theme === "dark" ? "Light theme" : "Dark theme"}
          </TooltipContent>
        </Tooltip>
      </div>

      <Dialog open={endOpen} onOpenChange={setEndOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>End this session?</DialogTitle>
            <DialogDescription>
              Everyone is disconnected and the workspace is removed after a
              minute. Guests cannot rejoin with the key. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEndOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (!self || !canEndSession(self)) {
                  toast.error("Only the host can end the session");
                  return;
                }
                send("host_action", { action: "end_session" });
                setEndOpen(false);
              }}
            >
              <DoorOpen className="h-4 w-4" /> End for everyone
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </header>
  );
}
