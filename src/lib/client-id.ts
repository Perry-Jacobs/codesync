const CLIENT_ID_KEY = "codesync:client-id";

/**
 * A stable, non-secret identifier for this browser installation. It lets the
 * backend apply a per-browser room-creation quota without penalizing students
 * or friends who share one public IP address.
 */
let memoryId: string | null = null;

export function clientInstallationId(): string {
  if (typeof window === "undefined") return "server";

  try {
    const existing = window.localStorage.getItem(CLIENT_ID_KEY);
    if (existing) return existing;
  } catch {
    // Storage can be unavailable in private or restricted browser contexts.
  }

  const id =
    memoryId ??
    (typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  memoryId = id;

  try {
    window.localStorage.setItem(CLIENT_ID_KEY, id);
  } catch {
    // Keep using the in-memory identifier for the current page lifetime.
  }
  return id;
}
