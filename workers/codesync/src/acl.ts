/**
 * Authoritative permission matrix. Shared by the gateway (enforcement) and the
 * UI (rendering). Never infer permissions from UI state on the server.
 */
import type { Participant, Role } from "./protocol";

export type Capability =
  | "edit_code"
  | "speak"
  | "chat"
  | "admit"
  | "kick"
  | "end_session"
  | "manage_roles"
  | "manage_media"
  | "lock_room"
  | "screen_share"
  | "file_write"
  | "save_workspace"
  | "fs_bridge";

const ALL: readonly Capability[] = [
  "edit_code",
  "speak",
  "chat",
  "admit",
  "kick",
  "end_session",
  "manage_roles",
  "manage_media",
  "lock_room",
  "screen_share",
  "file_write",
  "save_workspace",
  "fs_bridge",
];

const ROLE_CAPS: Record<Role, ReadonlySet<Capability>> = {
  HOST: new Set(ALL),
  CO_HOST: new Set(
    ALL.filter(
      (cap) =>
        cap !== "edit_code" &&
        cap !== "file_write" &&
        cap !== "speak" &&
        cap !== "end_session" &&
        cap !== "save_workspace" &&
        cap !== "fs_bridge",
    ),
  ),
  // Edit, file-write, and speak are grant-controlled for every non-host role.
  EDITOR: new Set<Capability>(["chat"]),
  VIEWER: new Set<Capability>(["chat"]),
  GUEST: new Set<Capability>(),
};

/** Effective capabilities for a participant, including per-user grants. */
export function capabilitiesOf(participant: Participant): Set<Capability> {
  const caps = new Set(ROLE_CAPS[participant.role]);
  if (participant.canEdit) {
    caps.add("edit_code");
    caps.add("file_write");
  }
  if (participant.canSpeak) caps.add("speak");
  return caps;
}

export function hasCapability(
  participant: Participant | null,
  capability: Capability,
): boolean {
  if (!participant || participant.state !== "ADMITTED") return false;
  return capabilitiesOf(participant).has(capability);
}

export function canKick(actor: Participant, target: Participant): boolean {
  if (actor.id === target.id) return false;
  if (target.role === "HOST") return false; // nobody can remove the host
  return hasCapability(actor, "kick");
}

export function canManageParticipant(
  actor: Participant,
  target: Participant,
): boolean {
  if (actor.id === target.id) return false;
  if (target.role === "HOST") return false;
  if (target.state !== "ADMITTED") return false;
  return hasCapability(actor, "manage_roles");
}

export function canTransferHost(actor: Participant): boolean {
  return actor.role === "HOST" && actor.state === "ADMITTED";
}

export function canEndSession(actor: Participant): boolean {
  return actor.role === "HOST" && actor.state === "ADMITTED";
}

export function canScreenShare(
  participant: Participant,
  allowGuestScreenShare: boolean,
): boolean {
  if (!hasCapability(participant, "chat")) return false;
  if (participant.role === "HOST" || participant.role === "CO_HOST")
    return true;
  return allowGuestScreenShare;
}

/** Initial per-user grants applied when a role changes. */
export function defaultsForRole(role: Role): {
  canEdit: boolean;
  canSpeak: boolean;
} {
  switch (role) {
    case "HOST":
    case "CO_HOST":
      return { canEdit: true, canSpeak: true };
    case "EDITOR":
      return { canEdit: true, canSpeak: false };
    case "VIEWER":
      return { canEdit: false, canSpeak: false };
    case "GUEST":
      return { canEdit: false, canSpeak: false };
  }
}

/** Co-hosts may assign every role except HOST; only the host transfers host. */
export function canAssignRole(actor: Participant, role: Role): boolean {
  if (role === "HOST") return false;
  if (!hasCapability(actor, "manage_roles")) return false;
  return role !== "GUEST";
}
