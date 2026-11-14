'use client';

/**
 * Small leading+trailing throttle used for high-frequency presence messages.
 * Returns a cancel handle so effects can flush their timers on cleanup.
 */
export interface Throttled<Args extends unknown[]> {
  (...args: Args): void;
  cancel(): void;
}

export function throttle<Args extends unknown[]>(
  fn: (...args: Args) => void,
  waitMs: number,
): Throttled<Args> {
  let lastCall = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: Args | null = null;

  const invoke = (): void => {
    timer = null;
    if (!pending) return;
    const args = pending;
    pending = null;
    lastCall = Date.now();
    fn(...args);
  };

  const throttled = (...args: Args): void => {
    const now = Date.now();
    const elapsed = now - lastCall;
    pending = args;
    if (elapsed >= waitMs) {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      invoke();
      return;
    }
    if (!timer) timer = setTimeout(invoke, waitMs - elapsed);
  };

  throttled.cancel = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
    pending = null;
  };

  return throttled;
}
