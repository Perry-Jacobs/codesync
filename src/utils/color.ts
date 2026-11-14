const SAFE_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
export const FALLBACK_PARTICIPANT_COLOR = '#4ea1ff';

/** Returns a color only when it is in the strict six-digit hex format. */
export function safeParticipantColor(value: string | null | undefined): string {
  return value && SAFE_COLOR_RE.test(value) ? value : FALLBACK_PARTICIPANT_COLOR;
}
