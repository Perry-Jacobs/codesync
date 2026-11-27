import { getEnv } from "@/lib/env";
import { getRedis, keys } from "@/lib/redis";
import type Redis from "ioredis";
import type { FileMeta } from "@/lib/ws-protocol";

function parseFile(raw: string): FileMeta | null {
  try {
    return JSON.parse(raw) as FileMeta;
  } catch {
    return null;
  }
}

export async function listFiles(roomId: string): Promise<FileMeta[]> {
  const raw = await getRedis().hgetall(keys.files(roomId));
  return Object.values(raw)
    .map(parseFile)
    .filter((file): file is FileMeta => file !== null)
    .sort((a, b) => a.path.localeCompare(b.path));
}

export async function getFileByPath(
  roomId: string,
  path: string,
): Promise<FileMeta | null> {
  const raw = await getRedis().hget(keys.files(roomId), path);
  return raw ? parseFile(raw) : null;
}

/**
 * The file list is on the hot path — every cursor, selection and document
 * update resolves a fileId. A fileId→path index hash keeps the lookup at two
 * HGETs instead of loading and sorting every entry. The index is written in
 * the same transaction as the file entry, and a miss falls back to the legacy
 * full scan so pre-index rooms keep working.
 */
export async function getFileById(
  roomId: string,
  fileId: string,
): Promise<FileMeta | null> {
  const redis = getRedis();
  const path = await redis.hget(keys.fileIndex(roomId), fileId);
  if (path) {
    const raw = await redis.hget(keys.files(roomId), path);
    const file = raw ? parseFile(raw) : null;
    if (file && file.fileId === fileId) return file;
  }
  const files = await listFiles(roomId);
  return files.find((file) => file.fileId === fileId) ?? null;
}

/** Keeps the fileId→path index and its room-key TTL tracking in step. */
function withIndexOps(
  multi: ReturnType<Redis["multi"]>,
  roomId: string,
): void {
  const ttl = getEnv().roomTtlSeconds;
  multi
    .sadd(keys.roomKeys(roomId), keys.fileIndex(roomId))
    .expire(keys.roomKeys(roomId), ttl)
    .expire(keys.fileIndex(roomId), ttl);
}

export async function upsertFile(
  roomId: string,
  file: FileMeta,
): Promise<void> {
  await getRedis()
    .multi()
    .hset(keys.files(roomId), file.path, JSON.stringify(file))
    .hset(keys.fileIndex(roomId), file.fileId, file.path)
    .expire(keys.files(roomId), getEnv().roomTtlSeconds)
    .expire(keys.fileIndex(roomId), getEnv().roomTtlSeconds)
    .sadd(keys.roomKeys(roomId), keys.fileIndex(roomId))
    .expire(keys.roomKeys(roomId), getEnv().roomTtlSeconds)
    .exec();
}

/**
 * Creates a file entry only if no entry occupies that path yet. The conflict
 * check and the write run in one Lua script so two concurrent creates of the
 * same path cannot both succeed.
 */
export async function createFileIfAbsent(
  roomId: string,
  file: FileMeta,
): Promise<boolean> {
  const result = await getRedis().eval(
    `
      if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 1 then return 0 end
      redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
      redis.call('HSET', KEYS[2], ARGV[3], ARGV[1])
      redis.call('EXPIRE', KEYS[1], tonumber(ARGV[4]))
      redis.call('EXPIRE', KEYS[2], tonumber(ARGV[4]))
      redis.call('SADD', KEYS[3], KEYS[2])
      redis.call('EXPIRE', KEYS[3], tonumber(ARGV[4]))
      return 1
    `,
    3,
    keys.files(roomId),
    keys.fileIndex(roomId),
    keys.roomKeys(roomId),
    file.path,
    JSON.stringify(file),
    file.fileId,
    getEnv().roomTtlSeconds,
  );
  return Number(result) === 1;
}

export async function replaceFiles(
  roomId: string,
  files: FileMeta[],
): Promise<void> {
  const redis = getRedis();
  const multi = redis.multi();
  multi.del(keys.files(roomId));
  multi.del(keys.fileIndex(roomId));
  if (files.length > 0) {
    const payload: Record<string, string> = {};
    const index: Record<string, string> = {};
    for (const file of files) {
      payload[file.path] = JSON.stringify(file);
      index[file.fileId] = file.path;
    }
    multi.hset(keys.files(roomId), payload);
    multi.hset(keys.fileIndex(roomId), index);
  }
  multi.expire(keys.files(roomId), getEnv().roomTtlSeconds);
  multi.expire(keys.fileIndex(roomId), getEnv().roomTtlSeconds);
  withIndexOps(multi, roomId);
  await multi.exec();
}

export async function removeFile(roomId: string, path: string): Promise<void> {
  const redis = getRedis();
  const raw = await redis.hget(keys.files(roomId), path);
  const file = raw ? parseFile(raw) : null;
  const multi = redis.multi().hdel(keys.files(roomId), path);
  if (file) multi.hdel(keys.fileIndex(roomId), file.fileId);
  await multi.exec();
}

export async function renameFile(
  roomId: string,
  from: string,
  to: string,
  file: FileMeta,
): Promise<void> {
  await renameFiles(roomId, [{ from, file: { ...file, path: to } }]);
}

/** Atomically updates every metadata path involved in a directory move. */
export async function renameFiles(
  roomId: string,
  moves: Array<{ from: string; file: FileMeta }>,
): Promise<void> {
  if (moves.length === 0) return;
  const redis = getRedis();
  const multi = redis.multi();
  const index: Record<string, string> = {};
  for (const { from, file } of moves) {
    multi.hdel(keys.files(roomId), from);
    multi.hset(keys.files(roomId), file.path, JSON.stringify(file));
    index[file.fileId] = file.path;
  }
  multi.hset(keys.fileIndex(roomId), index);
  multi.expire(keys.files(roomId), getEnv().roomTtlSeconds);
  multi.expire(keys.fileIndex(roomId), getEnv().roomTtlSeconds);
  withIndexOps(multi, roomId);
  await multi.exec();
}
