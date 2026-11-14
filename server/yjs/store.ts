import * as Y from "yjs";
import { getEnv } from "@/lib/env";
import { getRedis, keys } from "@/lib/redis";
import { createLogger } from "../logger";

const log = createLogger({ scope: "yjs" });
const MAX_LIVE_DOCS = 64;
const PERSIST_DEBOUNCE_MS = 1500;

interface DocEntry {
  doc: Y.Doc;
  refs: Set<string>;
  dirty: boolean;
  created: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  lastUsed: number;
}

const docs = new Map<string, DocEntry>();
const acquiring = new Map<string, Promise<DocEntry>>();

const docKey = (roomId: string, fileId: string) => `${roomId}:${fileId}`;

function textOf(doc: Y.Doc): Y.Text {
  return doc.getText("content");
}

async function loadSnapshot(
  roomId: string,
  fileId: string,
): Promise<Uint8Array | null> {
  const raw = await getRedis().getBuffer(keys.doc(roomId, fileId));
  return raw ? new Uint8Array(raw) : null;
}

function evictIfNeeded(): void {
  if (docs.size <= MAX_LIVE_DOCS) return;
  const candidates = [...docs.entries()]
    .filter(([, entry]) => entry.refs.size === 0)
    .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
  while (docs.size > MAX_LIVE_DOCS && candidates.length > 0) {
    const next = candidates.shift();
    if (!next) break;
    const [key, entry] = next;
    if (docs.get(key) !== entry || entry.refs.size > 0) continue;
    docs.delete(key);
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    const separator = key.indexOf(":");
    void persist(key.slice(0, separator), key.slice(separator + 1), entry);
  }
}

export interface AcquireResult {
  doc: Y.Doc;
  created: boolean;
}

export async function acquireDoc(
  roomId: string,
  fileId: string,
  socketId: string,
): Promise<AcquireResult> {
  const key = docKey(roomId, fileId);
  const existing = docs.get(key);
  if (existing) {
    existing.refs.add(socketId);
    existing.lastUsed = Date.now();
    return { doc: existing.doc, created: false };
  }

  let pending = acquiring.get(key);
  if (!pending) {
    pending = (async () => {
      const doc = new Y.Doc();
      const snapshot = await loadSnapshot(roomId, fileId);
      if (snapshot) Y.applyUpdate(doc, snapshot, "redis");
      const entry: DocEntry = {
        doc,
        refs: new Set(),
        dirty: false,
        created: snapshot === null,
        timer: null,
        lastUsed: Date.now(),
      };
      docs.set(key, entry);
      evictIfNeeded();
      return entry;
    })();
    acquiring.set(key, pending);
  }

  try {
    const entry = await pending;
    entry.refs.add(socketId);
    entry.lastUsed = Date.now();
    const created = entry.created;
    entry.created = false;
    return { doc: entry.doc, created };
  } finally {
    if (acquiring.get(key) === pending) acquiring.delete(key);
  }
}

export function releaseDoc(
  roomId: string,
  fileId: string,
  socketId: string,
): void {
  const entry = docs.get(docKey(roomId, fileId));
  if (!entry) return;
  entry.refs.delete(socketId);
  entry.lastUsed = Date.now();
  if (entry.refs.size === 0) {
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    void persist(roomId, fileId, entry);
  }
}

export function getDoc(roomId: string, fileId: string): Y.Doc | null {
  return docs.get(docKey(roomId, fileId))?.doc ?? null;
}

export function applyUpdate(
  roomId: string,
  fileId: string,
  update: Uint8Array,
  origin: string,
): boolean {
  const entry = docs.get(docKey(roomId, fileId));
  if (!entry) return false;
  try {
    Y.applyUpdate(entry.doc, update, origin);
  } catch (error) {
    log.warn("rejected update", { roomId, fileId, error: String(error) });
    return false;
  }
  entry.lastUsed = Date.now();
  markDirty(roomId, fileId, entry);
  return true;
}

export function encodeSnapshot(
  roomId: string,
  fileId: string,
): Uint8Array | null {
  const entry = docs.get(docKey(roomId, fileId));
  return entry ? Y.encodeStateAsUpdate(entry.doc) : null;
}

export function encodeDiff(
  roomId: string,
  fileId: string,
  stateVector?: Uint8Array,
): Uint8Array | null {
  const entry = docs.get(docKey(roomId, fileId));
  if (!entry) return null;
  return stateVector && stateVector.length > 0
    ? Y.encodeStateAsUpdate(entry.doc, stateVector)
    : Y.encodeStateAsUpdate(entry.doc);
}

/** Seeds a brand new doc (virtual workspace or first read from the host disk). */
export async function seedDoc(
  roomId: string,
  fileId: string,
  content: string,
  socketId: string,
): Promise<Y.Doc> {
  const { doc } = await acquireDoc(roomId, fileId, socketId);
  const text = textOf(doc);
  if (text.length === 0 && content.length > 0) {
    doc.transact(() => text.insert(0, content), "seed");
    const entry = docs.get(docKey(roomId, fileId));
    if (entry) markDirty(roomId, fileId, entry);
  }
  return doc;
}

export function replaceDocContent(
  roomId: string,
  fileId: string,
  content: string,
): void {
  const entry = docs.get(docKey(roomId, fileId));
  if (!entry) return;
  const text = textOf(entry.doc);
  entry.doc.transact(() => {
    if (text.length > 0) text.delete(0, text.length);
    if (content.length > 0) text.insert(0, content);
  }, "disk-sync");
  markDirty(roomId, fileId, entry);
}

/** Plain text snapshot used by the host filesystem bridge when writing to disk. */
export function readPlainText(roomId: string, fileId: string): string | null {
  const entry = docs.get(docKey(roomId, fileId));
  return entry ? textOf(entry.doc).toString() : null;
}

function markDirty(roomId: string, fileId: string, entry: DocEntry): void {
  entry.dirty = true;
  if (entry.timer) return;
  entry.timer = setTimeout(() => {
    entry.timer = null;
    void persist(roomId, fileId, entry);
  }, PERSIST_DEBOUNCE_MS);
}

async function persist(
  roomId: string,
  fileId: string,
  entry: DocEntry,
): Promise<void> {
  if (!entry.dirty) return;
  entry.dirty = false;
  try {
    const localSnapshot = Buffer.from(Y.encodeStateAsUpdate(entry.doc));
    const redisKey = keys.doc(roomId, fileId);
    const ttl = getEnv().roomTtlSeconds;

    // Merge the local Yjs state with the latest Redis snapshot, then use an
    // atomic compare-and-set. Concurrent gateway instances may both write, but
    // a stale snapshot can no longer overwrite a newer CRDT update.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = await getRedis().getBuffer(redisKey);
      let merged = localSnapshot;
      if (current) {
        const mergedDoc = new Y.Doc();
        Y.applyUpdate(mergedDoc, new Uint8Array(current), "redis");
        Y.applyUpdate(mergedDoc, localSnapshot, "local");
        merged = Buffer.from(Y.encodeStateAsUpdate(mergedDoc));
      }
      const result = await getRedis().eval(
        `
          local current = redis.call('GET', KEYS[1])
          local expected = ARGV[1]
          if (current or '') ~= expected then return 0 end
          redis.call('SET', KEYS[1], ARGV[2], 'EX', tonumber(ARGV[3]))
          return 1
        `,
        1,
        redisKey,
        current?.toString("base64") ?? "",
        merged.toString("base64"),
        ttl,
      );
      if (Number(result) === 1) {
        await getRedis()
          .multi()
          // Document keys are created after the room, so add them to the room's
          // tracked-key set to keep their TTL aligned with active rooms.
          .sadd(keys.roomKeys(roomId), redisKey)
          .expire(keys.roomKeys(roomId), ttl)
          .exec();
        return;
      }
    }
    throw new Error("snapshot changed too frequently to persist");
  } catch (error) {
    entry.dirty = true;
    log.error("snapshot failed", { roomId, fileId, error: String(error) });
  }
}

async function flushKey(key: string): Promise<void> {
  const entry = docs.get(key);
  if (!entry) return;
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  const separator = key.indexOf(":");
  const roomId = key.slice(0, separator);
  const fileId = key.slice(separator + 1);
  await persist(roomId, fileId, entry);
}

export async function flushDoc(roomId: string, fileId: string): Promise<void> {
  await flushKey(docKey(roomId, fileId));
}

export async function flushAll(): Promise<void> {
  await Promise.allSettled([...docs.keys()].map(flushKey));
}

export async function deleteDoc(roomId: string, fileId: string): Promise<void> {
  const key = docKey(roomId, fileId);
  await flushKey(key);
  if (docs.get(key)?.timer) clearTimeout(docs.get(key)?.timer ?? undefined);
  docs.delete(key);
  await getRedis().del(keys.doc(roomId, fileId));
}

export async function clearRoomDocs(roomId: string): Promise<void> {
  for (const key of [...docs.keys()]) {
    if (key.startsWith(`${roomId}:`)) {
      await flushKey(key);
      const entry = docs.get(key);
      if (entry?.timer) clearTimeout(entry.timer);
      docs.delete(key);
    }
  }
  const redis = getRedis();
  let cursor = "0";
  do {
    const [next, found] = await redis.scan(
      cursor,
      "MATCH",
      keys.doc(roomId, "*"),
      "COUNT",
      200,
    );
    cursor = next;
    if (found.length > 0) await redis.del(...found);
  } while (cursor !== "0");
}

export function liveDocCount(): number {
  return docs.size;
}
