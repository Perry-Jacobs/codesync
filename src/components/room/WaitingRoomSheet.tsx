"use client";

import { DoorOpen, Lock, ShieldCheck, UserCheck, Users } from "lucide-react";
import { useSession } from "@/components/providers/session-provider";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { hasCapability, ROLE_LABEL } from "@/lib/acl";
import { initials } from "@/lib/utils";
import type { Role } from "@/lib/ws-protocol";
import { safeParticipantColor } from "@/utils/color";
import { useRoomStore } from "@/stores/room.store";

interface WaitingRoomSheetProps {
  open: boolean;
  onOpenChange(open: boolean): void;
}

const ADMIT_ROLES: Role[] = ["VIEWER", "EDITOR", "CO_HOST"];

export function WaitingRoomSheet({
  open,
  onOpenChange,
}: WaitingRoomSheetProps) {
  const { send } = useSession();
  const waiting = useRoomStore((state) => state.waiting);
  const room = useRoomStore((state) => state.room);
  const self = useRoomStore((state) => state.self);

  const canAdmit = hasCapability(self, "admit");
  const canManageRoles = hasCapability(self, "manage_roles");
  const manual = room?.admitMode === "manual";
  const locked = room?.status === "locked";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col sm:max-w-md">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <UserCheck className="h-4 w-4 text-primary" /> Waiting room
            <span className="rounded-full bg-secondary px-2 py-0.5 text-xs font-medium text-muted-foreground">
              {waiting.length}
            </span>
          </SheetTitle>
          <SheetDescription>
            Admit people one by one, or open the doors for everyone queued up.
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 flex items-center gap-2">
          <Button
            className="flex-1"
            onClick={() => send("host_action", { action: "admit_all" })}
            disabled={waiting.length === 0 || !canAdmit}
          >
            <Users className="h-4 w-4" /> Admit all
          </Button>
          <Button
            variant="outline"
            onClick={() =>
              send("host_action", {
                action: locked ? "unlock_room" : "lock_room",
              })
            }
            disabled={!canAdmit}
          >
            <Lock className="h-4 w-4" /> {locked ? "Unlock" : "Lock"}
          </Button>
        </div>

        <div className="scrollbar-thin mt-4 min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
          {waiting.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border px-4 py-10 text-center">
              <DoorOpen className="mx-auto h-6 w-6 text-muted-foreground" />
              <p className="mt-2 text-sm font-medium">Nobody is waiting</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Share the session key and new guests will appear here.
              </p>
            </div>
          ) : (
            waiting.map((participant) => (
              <div
                key={participant.id}
                className="rounded-xl border border-border bg-card p-3"
              >
                <div className="flex items-center gap-2.5">
                  <Avatar className="h-8 w-8">
                    <AvatarFallback
                      style={{
                        backgroundColor: `${safeParticipantColor(participant.color)}33`,
                        color: safeParticipantColor(participant.color),
                      }}
                      className="text-[11px]"
                    >
                      {initials(participant.name)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {participant.name}
                    </p>
                    <p className="text-[10px] text-muted-foreground">
                      asked{" "}
                      {new Date(participant.joinedAt).toLocaleTimeString()}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    onClick={() =>
                      send("host_action", {
                        action: "deny",
                        targetId: participant.id,
                      })
                    }
                  >
                    Deny
                  </Button>
                </div>
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {ADMIT_ROLES.map((role) => {
                    const allowed =
                      role === "VIEWER" ||
                      (canManageRoles &&
                        (role !== "CO_HOST" || self?.role === "HOST"));
                    return (
                      <Button
                        key={role}
                        size="sm"
                        variant={role === "VIEWER" ? "default" : "outline"}
                        className="h-7 px-2 text-[11px]"
                        disabled={!canAdmit || !allowed}
                        onClick={() =>
                          send("host_action", {
                            action: "admit",
                            targetId: participant.id,
                            payload: { role },
                          })
                        }
                      >
                        Admit as {ROLE_LABEL[role]}
                      </Button>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </div>

        <Separator className="my-3" />

        <div className="space-y-3 pb-1">
          <label className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2 text-sm">
              <ShieldCheck className="h-4 w-4 text-primary" />
              <span>
                <span className="block font-medium">Manual admission</span>
                <span className="block text-xs text-muted-foreground">
                  New guests wait until you let them in.
                </span>
              </span>
            </span>
            <Switch
              checked={manual}
              disabled={!canAdmit}
              onCheckedChange={() =>
                send("host_action", { action: "toggle_admit_mode" })
              }
            />
          </label>

          <label className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2 text-sm">
              <Lock className="h-4 w-4 text-amber-400" />
              <span>
                <span className="block font-medium">Lock the room</span>
                <span className="block text-xs text-muted-foreground">
                  Blocks everyone new, including key holders.
                </span>
              </span>
            </span>
            <Switch
              checked={locked}
              disabled={!canAdmit}
              onCheckedChange={(next) =>
                send("host_action", {
                  action: next ? "lock_room" : "unlock_room",
                })
              }
            />
          </label>

          <label className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2 text-sm">
              <Users className="h-4 w-4 text-sky-400" />
              <span>
                <span className="block font-medium">
                  Guests may share their screen
                </span>
                <span className="block text-xs text-muted-foreground">
                  Host and co-hosts can always share.
                </span>
              </span>
            </span>
            <Switch
              checked={room?.allowGuestScreenShare ?? false}
              disabled={!hasCapability(self, "manage_media")}
              onCheckedChange={() =>
                send("host_action", { action: "toggle_screen_share" })
              }
            />
          </label>
        </div>
      </SheetContent>
    </Sheet>
  );
}
