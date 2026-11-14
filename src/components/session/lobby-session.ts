"use client";

const RECONNECT_CREDENTIAL_PREFIX = "codesync:rt:";

/**
 * Removes the reconnect credential for a room so the next lobby join is sent
 * without it. The server treats that credential as an existing participant;
 * after removal, only a credential-free join can create a new participant.
 */
export function clearReconnectCredential(roomKey: string): void {
  window.sessionStorage.removeItem(`${RECONNECT_CREDENTIAL_PREFIX}${roomKey}`);
}
