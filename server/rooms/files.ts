import { getEnv } from "@/lib/env";
import { getRedis, keys } from "@/lib/redis";
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

export async function getFileById(
  roomId: string,
  fileId: string,
): Promise<FileMeta | null> {
  const files = await listFiles(roomId);
  return files.find((file) => file.fileId === fileId) ?? null;
}

export async function upsertFile(
  roomId: string,
  file: FileMeta,
): Promise<void> {
  await getRedis()
    .multi()
    .hset(keys.files(roomId), file.path, JSON.stringify(file))
    .expire(keys.files(roomId), getEnv().roomTtlSeconds)
    .exec();
}

export async function replaceFiles(
  roomId: string,
  files: FileMeta[],
): Promise<void> {
  const redis = getRedis();
  const multi = redis.multi();
  multi.del(keys.files(roomId));
  if (files.length > 0) {
    const payload: Record<string, string> = {};
    for (const file of files) payload[file.path] = JSON.stringify(file);
    multi.hset(keys.files(roomId), payload);
  }
  multi.expire(keys.files(roomId), getEnv().roomTtlSeconds);
  await multi.exec();
}

export async function removeFile(roomId: string, path: string): Promise<void> {
  await getRedis().hdel(keys.files(roomId), path);
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
  for (const { from } of moves) multi.hdel(keys.files(roomId), from);
  for (const { file } of moves) {
    multi.hset(keys.files(roomId), file.path, JSON.stringify(file));
  }
  multi.expire(keys.files(roomId), getEnv().roomTtlSeconds);
  await multi.exec();
}
