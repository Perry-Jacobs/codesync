import { nanoid } from 'nanoid';

/** 3 char namespace + 18 random chars = the 21 char session key. */
export const SESSION_KEY_PREFIX = 'zk-';
export const SESSION_KEY_RANDOM_LENGTH = 18;
export const SESSION_KEY_LENGTH = SESSION_KEY_PREFIX.length + SESSION_KEY_RANDOM_LENGTH;

const SESSION_KEY_RE = /^zk-[A-Za-z0-9_-]{18}$/;

export function generateSessionKey(): string {
  return `${SESSION_KEY_PREFIX}${nanoid(SESSION_KEY_RANDOM_LENGTH)}`;
}

export function isValidSessionKey(value: string | null | undefined): value is string {
  return typeof value === 'string' && SESSION_KEY_RE.test(value);
}

export function normalizeSessionKey(value: string): string {
  return value.trim().replace(/\s+/g, '');
}

/** `zk-9fX2…8uW` for compact UI surfaces. */
export function shortSessionKey(key: string): string {
  return key.length <= 9 ? key : `${key.slice(0, 6)}…${key.slice(-4)}`;
}

export function joinUrl(origin: string, key: string): string {
  return `${origin.replace(/\/$/, '')}/join/${key}`;
}
