"use client";

import {
  Crown,
  Hand,
  Lock,
  Mic,
  MicOff,
  Monitor,
  MoreHorizontal,
  PencilLine,
  Shield,
  UserCheck,
  Users,
  Video,
  VideoOff,
} from "lucide-react";
import { useSession } from "@/components/providers/session-provider";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  canAssignRole,
  canKick,
  canTransferHost,
  hasCapability,
  ROLE_LABEL,
} from "@/lib/acl";
import { cn, initials } from "@/lib/utils";
import { safeParticipantColor } from "@/utils/color";
import type { HostAction, Participant, Role } from "@/lib/ws-protocol";
import { useRoomStore } from "@/stores/room.store";
import { useUiStore } from "@/stores/ui.store";

const ROLE_TONE: Record<Role, "default" | "secondary" | "outline" | "warning"> =
  {
    HOST: "warning",
    CO_HOST: "default",
    EDITOR: "secondary",
    VIEWER: "outline",
    GUEST: "outline",
  };

const ASSIGNABLE: Role[] = ["CO_HOST", "EDITOR", "VIEWER"];

interface ParticipantRailProps {
  onOpenWaiting(): void;
  variant?: "desktop" | "drawer";
}

export function ParticipantRail({
  onOpenWaiting,
  variant = "desktop",
}: ParticipantRailProps) {
  const { send } = useSession();
  const self = useRoomStore((state) => state.self);
  const participants = useRoomStore((state) => state.participants);
  const waiting = useRoomStore((state) => state.waiting);
  const room = useRoomStore((state) => state.room);
  const followingId = useUiStore((state) => state.followingId);
  const setFollowing = useUiStore((state) => state.setFollowing);

  const canAdmit = hasCapability(self, "admit");
  const ordered = [...participants].sort((a, b) => {
    const roleDelta =
      (a.role === "HOST" ? 0 : a.role === "CO_HOST" ? 1 : 2) -
      (b.role === "HOST" ? 0 : b.role === "CO_HOST" ? 1 : 2);
    return roleDelta !== 0 ? roleDelta : a.name.localeCompare(b.name);
  });

  const act = (
    target: Participant,
    action: HostAction,
    payload?: Record<string, unknown>,
  ): void => {
    send("host_action", {
      action,
      targetId: target.id,
      payload,
    });
  };

  const roleItems = (target: Participant): React.ReactNode =>
    ASSIGNABLE.map((role) => (
      <ContextMenuItem
        key={role}
        disabled={!self || !canAssignRole(self, role) || target.role === role}
        onSelect={() => act(target, "set_role", { role })}
      >
        {ROLE_LABEL[role]}
      </ContextMenuItem>
    ));

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <header
        className={cn(
          "flex shrink-0 items-center gap-2 border-b border-border px-3",
          variant === "drawer" ? "h-12" : "h-9",
        )}
      >
        <Users className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          People
        </span>
        <span className="text-[10px] text-muted-foreground">
          {participants.length}/{room?.maxParticipants ?? 8}
        </span>
        {room?.status === "locked" ? (
          <Lock className="ml-1 h-3 w-3 text-amber-400" />
        ) : null}
        {canAdmit ? (
          <Button
            variant="outline"
            size="sm"
            className={cn(
              "ml-auto gap-1",
              variant === "drawer"
                ? "h-9 px-3 text-xs"
                : "h-6 px-2 text-[10px]",
            )}
            onClick={onOpenWaiting}
          >
            <UserCheck className="h-3 w-3" />
            {waiting.length > 0 ? `${waiting.length} waiting` : "Waiting room"}
          </Button>
        ) : null}
      </header>

      <div
        className={cn(
          "scrollbar-thin min-h-0 flex-1 overflow-y-auto",
          variant === "drawer" ? "space-y-1 p-3" : "p-1.5",
        )}
      >
        {ordered.map((participant) => {
          const isSelf = participant.id === self?.id;
          const following = followingId === participant.id;
          const canManage = self
            ? canTransferHost(self) || hasCapability(self, "manage_roles")
            : false;
          const showMenu =
            !!self &&
            !isSelf &&
            (canManage ||
              canKick(self, participant) ||
              hasCapability(self, "manage_media"));

          return (
            <ContextMenu key={participant.id}>
              <ContextMenuTrigger asChild>
                <div
                  role="button"
                  tabIndex={0}
                  aria-label={`${participant.name}, ${ROLE_LABEL[participant.role]}`}
                  className={cn(
                    "group flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-white/5",
                    following && "bg-primary/10 ring-1 ring-primary/30",
                    participant.typing && "bg-emerald-500/5",
                    participant.handRaised && "bg-amber-400/5",
                  )}
                  onClick={() => {
                    if (isSelf || !hasCapability(participant, "edit_code"))
                      return;
                    setFollowing(following ? null : participant.id);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    if (isSelf || !hasCapability(participant, "edit_code"))
                      return;
                    setFollowing(following ? null : participant.id);
                  }}
                >
                  <Avatar
                    className={cn(
                      variant === "drawer"
                        ? "h-9 w-9 shrink-0"
                        : "h-7 w-7 shrink-0",
                      participant.handRaised &&
                        "ring-2 ring-amber-400/60 ring-offset-2 ring-offset-card",
                    )}
                  >
                    <AvatarFallback
                      style={{
                        backgroundColor: `${safeParticipantColor(participant.color)}33`,
                        color: safeParticipantColor(participant.color),
                      }}
                      className={
                        variant === "drawer" ? "text-xs" : "text-[10px]"
                      }
                    >
                      {initials(participant.name)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1">
                      <span
                        className={cn(
                          "truncate font-medium text-foreground",
                          variant === "drawer" ? "text-sm" : "text-xs",
                        )}
                      >
                        {participant.name}
                      </span>
                      {isSelf ? (
                        <span className="text-[9px] text-muted-foreground">
                          (you)
                        </span>
                      ) : null}
                      {participant.role === "HOST" ? (
                        <Crown className="h-3 w-3 shrink-0 text-amber-400" />
                      ) : participant.role === "CO_HOST" ? (
                        <Shield className="h-3 w-3 shrink-0 text-sky-400" />
                      ) : null}
                      {participant.typing ? (
                        <span className="ml-1 flex items-center gap-0.5">
                          <span className="h-1 w-1 animate-bounce rounded-full bg-emerald-400" />
                          <span className="h-1 w-1 animate-bounce rounded-full bg-emerald-400 [animation-delay:120ms]" />
                          <span className="h-1 w-1 animate-bounce rounded-full bg-emerald-400 [animation-delay:240ms]" />
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-0.5 flex items-center gap-1.5 text-[9px] text-muted-foreground">
                      <Badge
                        variant={ROLE_TONE[participant.role]}
                        className={
                          variant === "drawer"
                            ? "px-1.5 py-0.5 text-[10px]"
                            : "px-1 py-0 text-[8px]"
                        }
                      >
                        {ROLE_LABEL[participant.role]}
                      </Badge>
                      {participant.canEdit ? (
                        <PencilLine className="h-2.5 w-2.5 text-emerald-400" />
                      ) : null}
                      {participant.mic ? (
                        <Mic className="h-2.5 w-2.5 text-emerald-400" />
                      ) : (
                        <MicOff className="h-2.5 w-2.5" />
                      )}
                      {participant.cam ? (
                        <Video className="h-2.5 w-2.5 text-sky-400" />
                      ) : (
                        <VideoOff className="h-2.5 w-2.5" />
                      )}
                      {participant.screen ? (
                        <Monitor className="h-2.5 w-2.5 text-violet-400" />
                      ) : null}
                      {participant.handRaised ? (
                        <span
                          className={cn(
                            "inline-flex items-center gap-0.5 rounded-full bg-amber-500/15 font-semibold text-amber-700 dark:text-amber-300",
                            variant === "drawer"
                              ? "px-1.5 py-0.5 text-[10px]"
                              : "px-1 py-px text-[8px]",
                          )}
                        >
                          <Hand className="h-2 w-2" /> Hand raised
                        </span>
                      ) : null}
                    </div>
                  </div>
                  {showMenu ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className={cn(
                            "opacity-0 group-hover:opacity-100 focus:opacity-100",
                            variant === "drawer" ? "h-8 w-8" : "h-6 w-6",
                          )}
                          onClick={(event) => event.stopPropagation()}
                          aria-label={`Actions for ${participant.name}`}
                        >
                          <MoreHorizontal className="h-3.5 w-3.5" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        align="end"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <DropdownMenuLabel>
                          {participant.name}
                        </DropdownMenuLabel>
                        {self && hasCapability(self, "manage_roles") ? (
                          <DropdownMenuSub>
                            <DropdownMenuSubTrigger>
                              Change role
                            </DropdownMenuSubTrigger>
                            <DropdownMenuSubContent>
                              {ASSIGNABLE.map((role) => (
                                <DropdownMenuItem
                                  key={role}
                                  disabled={
                                    !canAssignRole(self, role) ||
                                    participant.role === role
                                  }
                                  onSelect={() =>
                                    act(participant, "set_role", { role })
                                  }
                                >
                                  {ROLE_LABEL[role]}
                                </DropdownMenuItem>
                              ))}
                            </DropdownMenuSubContent>
                          </DropdownMenuSub>
                        ) : null}
                        {self && hasCapability(self, "manage_roles") ? (
                          <DropdownMenuItem
                            onSelect={() =>
                              act(
                                participant,
                                participant.canEdit
                                  ? "revoke_edit"
                                  : "grant_edit",
                              )
                            }
                          >
                            <PencilLine />
                            {participant.canEdit
                              ? "Revoke edit access"
                              : "Grant edit access"}
                          </DropdownMenuItem>
                        ) : null}
                        {self && hasCapability(self, "manage_media") ? (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onSelect={() =>
                                act(
                                  participant,
                                  participant.canSpeak
                                    ? "revoke_speak"
                                    : "grant_speak",
                                )
                              }
                            >
                              <Mic />
                              {participant.canSpeak
                                ? "Revoke speak"
                                : "Grant speak"}
                            </DropdownMenuItem>
                            {participant.mic ? (
                              <DropdownMenuItem
                                onSelect={() => act(participant, "mute")}
                              >
                                <MicOff /> Mute
                              </DropdownMenuItem>
                            ) : participant.canSpeak ? (
                              <DropdownMenuItem
                                onSelect={() => act(participant, "ask_unmute")}
                              >
                                <Mic /> Ask to unmute
                              </DropdownMenuItem>
                            ) : null}
                          </>
                        ) : null}
                        {self && canTransferHost(self) ? (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onSelect={() => act(participant, "transfer_host")}
                            >
                              <Crown /> Transfer host
                            </DropdownMenuItem>
                          </>
                        ) : null}
                        {self && canKick(self, participant) ? (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              className="text-destructive"
                              onSelect={() => act(participant, "kick")}
                            >
                              <VideoOff /> Remove from room
                            </DropdownMenuItem>
                          </>
                        ) : null}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null}
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuLabel>{participant.name}</ContextMenuLabel>
                {self && hasCapability(self, "manage_roles") ? (
                  <ContextMenuSub>
                    <ContextMenuSubTrigger>Change role</ContextMenuSubTrigger>
                    <ContextMenuSubContent>
                      {roleItems(participant)}
                    </ContextMenuSubContent>
                  </ContextMenuSub>
                ) : null}
                {!isSelf && hasCapability(participant, "edit_code") ? (
                  <ContextMenuItem
                    onSelect={() =>
                      setFollowing(following ? null : participant.id)
                    }
                  >
                    {following ? "Stop following" : "Follow cursor"}
                  </ContextMenuItem>
                ) : null}
                <ContextMenuSeparator />
                <ContextMenuItem
                  onSelect={() => {
                    void navigator.clipboard.writeText(participant.id);
                  }}
                >
                  Copy participant id
                </ContextMenuItem>
                {self && canKick(self, participant) ? (
                  <ContextMenuItem
                    className="text-destructive"
                    onSelect={() => act(participant, "kick")}
                  >
                    Remove from room
                  </ContextMenuItem>
                ) : null}
              </ContextMenuContent>
            </ContextMenu>
          );
        })}
      </div>

      {followingId ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => setFollowing(null)}
              className="mx-2 mb-1 rounded-md border border-primary/30 bg-primary/10 px-2 py-1 text-left text-[10px] text-primary"
            >
              Following{" "}
              {participants.find((entry) => entry.id === followingId)?.name ??
                "…"}{" "}
              · click to stop
            </button>
          </TooltipTrigger>
          <TooltipContent>Escape also stops following</TooltipContent>
        </Tooltip>
      ) : null}
    </section>
  );
}
