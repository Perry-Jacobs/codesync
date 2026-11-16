import { getEnv } from "@/lib/env";
import { getRedis, keys } from "@/lib/redis";
import { defaultsForRole } from "@/lib/acl";
import { generateSessionKey } from "@/utils/sessionKey";
import type {
  AdmitMode,
  ChatMessage,
  ParticipantState,
  Role,
} from "@/lib/ws-protocol";
import { generateHostToken, newId, sha256, storeHostToken } from "./tokens";
import {
  isParticipantRecord,
  pickColor,
  type ParticipantRecord,
  type RoomRecord,
} from "./types";

export {
  getFileById,
  getFileByPath,
  listFiles,
  removeFile,
  renameFile,
  renameFiles,
  replaceFiles,
  upsertFile,
} from "./files";

/** Serialises read-modify-write cycles for a room inside this process. */
const locks = new Map<string, Promise<unknown>>();

export async function withRoomLock<T>(
  roomId: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = locks.get(roomId) ?? Promise.resolve();
  const run = previous.then(task, task);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  locks.set(roomId, tail);
  try {
    return await run;
  } finally {
    if (locks.get(roomId) === tail) locks.delete(roomId);
  }
}

const touchState = new Map<string, number>();

function parseRoom(raw: string | null): RoomRecord | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RoomRecord;
  } catch {
    return null;
  }
}

function parseParticipant(raw: string): ParticipantRecord | null {
  try {
    const value: unknown = JSON.parse(raw);
    return isParticipantRecord(value) ? value : null;
  } catch {
    return null;
  }
}

export interface CreateRoomInput {
  hostName: string;
  title?: string;
  admitMode?: AdmitMode;
}

export interface CreateRoomResult {
  room: RoomRecord;
  host: ParticipantRecord;
  hostToken: string;
}

export async function createRoom(
  input: CreateRoomInput,
): Promise<CreateRoomResult> {
  const env = getEnv();
  const now = Date.now();
  const sessionKey = generateSessionKey();
  const keyHash = sha256(sessionKey);
  const roomId = newId("r");
  const hostId = newId("p");

  const room: RoomRecord = {
    id: roomId,
    key: sessionKey,
    title: input.title?.trim() || "Untitled workspace",
    status: "open",
    admitMode: input.admitMode ?? "auto",
    hostParticipantId: hostId,
    allowGuestScreenShare: false,
    maxParticipants: env.MAX_PARTICIPANTS,
    workspaceMode: "virtual",
    rootName: null,
    createdAt: now,
    lastActivityAt: now,
  };

  const grants = defaultsForRole("HOST");
  const host: ParticipantRecord = {
    id: hostId,
    name: input.hostName.trim().slice(0, 48) || "Host",
    role: "HOST",
    color: pickColor(0),
    state: "ADMITTED",
    canEdit: grants.canEdit,
    canSpeak: grants.canSpeak,
    mic: false,
    cam: false,
    screen: false,
    handRaised: false,
    typing: false,
    joinedAt: now,
    socketId: null,
    lastSeenAt: now,
  };

  const hostToken = generateHostToken();
  const ttl = env.roomTtlSeconds;
  const tracked = [
    keys.room(roomId),
    keys.participants(roomId),
    keys.queue(roomId),
    keys.chat(roomId),
    keys.files(roomId),
    keys.host(roomId),
    keys.keyLookup(keyHash),
    keys.roomKeys(roomId),
  ];

  const redis = getRedis();
  await redis
    .multi()
    .set(keys.room(roomId), JSON.stringify(room), "EX", ttl)
    .hset(keys.participants(roomId), hostId, JSON.stringify(host))
    .set(keys.keyLookup(keyHash), roomId, "EX", ttl)
    .sadd(keys.activeRooms(), roomId)
    .sadd(keys.roomKeys(roomId), ...tracked)
    .expire(keys.participants(roomId), ttl)
    .expire(keys.queue(roomId), ttl)
    .expire(keys.chat(roomId), ttl)
    .expire(keys.files(roomId), ttl)
    .expire(keys.host(roomId), ttl)
    .expire(keys.roomKeys(roomId), ttl)
    .sadd(keys.activeRooms(), roomId)
    .exec();

  await storeHostToken(roomId, hostId, hostToken);
  return { room, host, hostToken };
}

export async function getRoom(roomId: string): Promise<RoomRecord | null> {
  return parseRoom(await getRedis().get(keys.room(roomId)));
}

export async function getRoomByKey(
  sessionKey: string,
): Promise<RoomRecord | null> {
  const roomId = await getRedis().get(keys.keyLookup(sha256(sessionKey)));
  if (!roomId) return null;
  return getRoom(roomId);
}

export async function getEndedMarker(sessionKey: string): Promise<boolean> {
  const redis = getRedis();
  const marker = await redis.get(keys.ended(sha256(sessionKey)));
  return Boolean(marker);
}

export async function updateRoom(
  roomId: string,
  patch: Partial<RoomRecord>,
): Promise<RoomRecord | null> {
  // Apply only the requested fields in Redis so concurrent gateway instances
  // cannot overwrite each other's changes with stale whole-room snapshots.
  // An ended room is terminal and cannot be reopened by a late update.
  const raw = await getRedis().eval(
    `
      local roomRaw = redis.call('GET', KEYS[1])
      if not roomRaw then return nil end
      local okRoom, room = pcall(cjson.decode, roomRaw)
      if not okRoom then return nil end
      if room.status == 'ended' then return nil end
      local okPatch, patch = pcall(cjson.decode, ARGV[1])
      if not okPatch then return nil end
      for field, value in pairs(patch) do
        room[field] = value
      end
      room.lastActivityAt = tonumber(ARGV[2])
      redis.call('SET', KEYS[1], cjson.encode(room), 'KEEPTTL')
      return cjson.encode(room)
    `,
    1,
    keys.room(roomId),
    JSON.stringify(patch),
    Date.now(),
  );
  if (raw === null) return null;
  try {
    return JSON.parse(String(raw)) as RoomRecord;
  } catch {
    return null;
  }
}

/** Atomically transfers host ownership and invalidates the old host token. */
export async function transferHost(
  roomId: string,
  oldHost: ParticipantRecord,
  newHost: ParticipantRecord,
): Promise<{ room: RoomRecord; hostToken: string } | null> {
  const hostToken = generateHostToken();
  const result = await getRedis().eval(
    `
      local roomRaw = redis.call('GET', KEYS[1])
      if not roomRaw then return nil end
      local oldRaw = redis.call('HGET', KEYS[2], ARGV[1])
      local newRaw = redis.call('HGET', KEYS[2], ARGV[2])
      if not oldRaw or not newRaw then return nil end
      local okRoom, room = pcall(cjson.decode, roomRaw)
      local okOld, oldParticipant = pcall(cjson.decode, oldRaw)
      local okNew, newParticipant = pcall(cjson.decode, newRaw)
      if not okRoom or not okOld or not okNew then return nil end
      if room.hostParticipantId ~= ARGV[1] or oldParticipant.role ~= 'HOST' then return nil end
      if room.status == 'ended' then return nil end
      if newParticipant.state ~= 'ADMITTED' then return nil end
      room.hostParticipantId = ARGV[2]
      room.lastActivityAt = tonumber(ARGV[3])
      oldParticipant.role = 'CO_HOST'
      oldParticipant.canEdit = true
      oldParticipant.canSpeak = true
      newParticipant.role = 'HOST'
      newParticipant.canEdit = true
      newParticipant.canSpeak = true
      redis.call('SET', KEYS[1], cjson.encode(room), 'KEEPTTL')
      redis.call('HSET', KEYS[2], ARGV[1], cjson.encode(oldParticipant))
      redis.call('HSET', KEYS[2], ARGV[2], cjson.encode(newParticipant))
      redis.call('SET', KEYS[3], cjson.encode({
        participantId = ARGV[2],
        tokenHash = ARGV[4]
      }), 'EX', ARGV[5])
      return cjson.encode({ room = room, hostToken = ARGV[6] })
    `,
    3,
    keys.room(roomId),
    keys.participants(roomId),
    keys.host(roomId),
    oldHost.id,
    newHost.id,
    Date.now(),
    sha256(hostToken),
    getEnv().roomTtlSeconds * 4,
    hostToken,
  );
  if (result === null) return null;
  try {
    return JSON.parse(String(result)) as {
      room: RoomRecord;
      hostToken: string;
    };
  } catch {
    return null;
  }
}

/** Refreshes key TTLs at most once per minute per room while sockets are alive. */
export async function touchRoom(roomId: string): Promise<void> {
  const now = Date.now();
  const last = touchState.get(roomId) ?? 0;
  if (now - last < 60_000) return;
  touchState.set(roomId, now);
  const ttl = getEnv().roomTtlSeconds;
  const redis = getRedis();
  const multi = redis.multi();
  const tracked = await redis.smembers(keys.roomKeys(roomId));
  for (const key of tracked) multi.expire(key, ttl);
  await multi.exec();
}

export async function scheduleRoomExpiry(roomId: string): Promise<void> {
  touchState.delete(roomId);
  const room = await getRoom(roomId);
  if (!room) return;
  const redis = getRedis();
  const tracked = await redis.smembers(keys.roomKeys(roomId));
  const multi = redis.multi();
  for (const key of tracked) multi.expire(key, getEnv().roomTtlSeconds);
  multi.set(
    keys.room(roomId),
    JSON.stringify({ ...room, lastActivityAt: Date.now() }),
    "KEEPTTL",
  );
  await multi.exec();
}

export async function reviveRoom(roomId: string): Promise<void> {
  const redis = getRedis();
  const tracked = await redis.smembers(keys.roomKeys(roomId));
  if (tracked.length === 0) return;
  const ttl = getEnv().roomTtlSeconds;
  const multi = redis.multi();
  for (const key of tracked) multi.expire(key, ttl);
  await multi.exec();
  touchState.set(roomId, Date.now());
}

export async function listParticipants(
  roomId: string,
): Promise<ParticipantRecord[]> {
  const raw = await getRedis().hgetall(keys.participants(roomId));
  return Object.values(raw)
    .map(parseParticipant)
    .filter((p): p is ParticipantRecord => p !== null);
}

/**
 * How long a dropped participant keeps their seat while they may reconnect.
 * Their record survives a socket drop so a reconnect token keeps their role,
 * but it must not linger as a ghost in the roster or hold a seat forever.
 */
export const PARTICIPANT_GRACE_MS = 60_000;

/** True while a participant is connected, or recently dropped and expected back. */
export function isParticipantPresent(
  participant: ParticipantRecord,
  now = Date.now(),
): boolean {
  if (participant.state !== "ADMITTED") return false;
  if (participant.socketId !== null) return true;
  return now - participant.lastSeenAt < PARTICIPANT_GRACE_MS;
}

/** Drops disconnected participants whose reconnect window has elapsed. */
export async function pruneStaleParticipants(
  roomId: string,
): Promise<string[]> {
  const now = Date.now();
  const [room, participants] = await Promise.all([
    getRoom(roomId),
    listParticipants(roomId),
  ]);
  const stale = participants.filter(
    (participant) =>
      participant.state === "ADMITTED" &&
      participant.socketId === null &&
      // The host record anchors the room: keep it so the host token can always
      // reclaim the session, even after a long disconnect.
      participant.id !== room?.hostParticipantId &&
      now - participant.lastSeenAt >= PARTICIPANT_GRACE_MS,
  );
  if (stale.length > 0) {
    await Promise.all(
      stale.map((participant) => removeParticipant(roomId, participant.id)),
    );
  }
  return stale.map((participant) => participant.id);
}

export async function getParticipant(
  roomId: string,
  participantId: string,
): Promise<ParticipantRecord | null> {
  const raw = await getRedis().hget(keys.participants(roomId), participantId);
  return raw ? parseParticipant(raw) : null;
}

/**
 * Reserve a participant slot and insert the participant in one Redis script.
 * The count and the write therefore cannot interleave with another join or
 * admission in another gateway process.
 */
const RESERVE_SLOT_SCRIPT = `
  local roomRaw = redis.call('GET', KEYS[2])
  if not roomRaw then return 3 end
  local okRoom, room = pcall(cjson.decode, roomRaw)
  if not okRoom then return 3 end
  if room.status == 'ended' then return 3 end
  if room.status == 'locked' then return 2 end
  local values = redis.call('HGETALL', KEYS[1])
  local count = 0
  for index = 1, #values, 2 do
    local ok, participant = pcall(cjson.decode, values[index])
    if ok and participant.state == ARGV[1] then
      count = count + 1
    end
  end
  if count >= tonumber(ARGV[2]) then
    return 0
  end
  redis.call('HSET', KEYS[1], ARGV[3], ARGV[4])
  return 1
`;

const ADMIT_SLOT_SCRIPT = `
  local roomRaw = redis.call('GET', KEYS[2])
  if not roomRaw then return 0 end
  local okRoom, room = pcall(cjson.decode, roomRaw)
  if not okRoom or room.status == 'ended' then return 0 end
  local current = redis.call('HGET', KEYS[1], ARGV[2])
  if not current then
    return 0
  end
  local okCurrent, participantCurrent = pcall(cjson.decode, current)
  if not okCurrent or participantCurrent.state ~= 'WAITING' then
    return 0
  end
  local values = redis.call('HGETALL', KEYS[1])
  local count = 0
  for index = 1, #values, 2 do
    local ok, participant = pcall(cjson.decode, values[index])
    if ok and participant.state == 'ADMITTED' and participant.id ~= ARGV[2] then
      count = count + 1
    end
  end
  if count >= tonumber(ARGV[1]) then
    return 0
  end
  redis.call('HSET', KEYS[1], ARGV[2], ARGV[3])
  return 1
`;

export type ParticipantReservation =
  "reserved" | "limit" | "locked" | "ended" | "missing";

export async function reserveParticipantSlot(
  roomId: string,
  participant: ParticipantRecord,
  maxParticipants: number,
  state: "ADMITTED" | "WAITING",
): Promise<ParticipantReservation> {
  const result = await getRedis().eval(
    RESERVE_SLOT_SCRIPT,
    2,
    keys.participants(roomId),
    keys.room(roomId),
    state,
    maxParticipants,
    participant.id,
    JSON.stringify(participant),
  );
  switch (Number(result)) {
    case 1:
      return "reserved";
    case 2:
      return "locked";
    case 3:
      return "ended";
    default:
      return "limit";
  }
}

export async function admitParticipantSlot(
  roomId: string,
  participant: ParticipantRecord,
  maxParticipants: number,
): Promise<boolean> {
  const result = await getRedis().eval(
    ADMIT_SLOT_SCRIPT,
    2,
    keys.participants(roomId),
    keys.room(roomId),
    maxParticipants,
    participant.id,
    JSON.stringify(participant),
  );
  return Number(result) === 1;
}

const PARTICIPANT_UPDATE_SCRIPT = `
  local raw = redis.call('HGET', KEYS[1], ARGV[1])
  if not raw then return nil end
  local ok, participant = pcall(cjson.decode, raw)
  if not ok then return nil end

  -- Terminal records are immutable: a stale media, hand, or detach update must
  -- never resurrect a participant after a kick or denial.
  if participant.state == 'REMOVED' or participant.state == 'DENIED' then
    return nil
  end

  if ARGV[2] ~= '' and participant.socketId ~= ARGV[2] then
    return nil
  end

  local allowed = {
    role = true,
    canEdit = true,
    canSpeak = true,
    mic = true,
    cam = true,
    screen = true,
    handRaised = true,
    typing = true,
    state = true,
    socketId = true,
    lastSeenAt = true
  }

  for index = 3, #ARGV, 2 do
    local field = ARGV[index]
    if allowed[field] then
      local valueOk, value = pcall(cjson.decode, ARGV[index + 1])
      if valueOk then participant[field] = value end
    end
  end

  redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(participant))
  return cjson.encode(participant)
`;

/**
 * Atomically merges selected participant fields. Client-driven updates must
 * use this instead of writing a stale whole-record snapshot, otherwise a
 * concurrent permission revoke or kick can be undone.
 */
export async function updateParticipant(
  roomId: string,
  participantId: string,
  patch: Partial<ParticipantRecord>,
  options: { requireSocketId?: string } = {},
): Promise<ParticipantRecord | null> {
  const args = [participantId, options.requireSocketId ?? ""];
  for (const [field, value] of Object.entries(patch)) {
    const encoded = JSON.stringify(value);
    if (encoded !== undefined) args.push(field, encoded);
  }
  const raw = await getRedis().eval(
    PARTICIPANT_UPDATE_SCRIPT,
    1,
    keys.participants(roomId),
    ...args,
  );
  if (raw === null) return null;
  try {
    return parseParticipant(String(raw));
  } catch {
    return null;
  }
}

/**
 * Claims an existing admitted identity without overwriting its role or grants.
 * Reconnect claims require an open room; host claims may still enter a locked
 * room. In either case a waiting, left, denied, or removed participant is never
 * promoted to admitted by the claim.
 */
export async function claimParticipantSocket(
  roomId: string,
  participantId: string,
  socketId: string,
  mic: boolean,
  cam: boolean,
  options: { allowLocked?: boolean } = {},
): Promise<ParticipantRecord | null> {
  const result = await getRedis().eval(
    `
      local roomRaw = redis.call('GET', KEYS[2])
      if not roomRaw then return nil end
      local okRoom, room = pcall(cjson.decode, roomRaw)
      if not okRoom or room.status == 'ended' then return nil end
      if room.status == 'locked' and ARGV[6] ~= '1' then return nil end
      local raw = redis.call('HGET', KEYS[1], ARGV[1])
      if not raw then return nil end
      local ok, participant = pcall(cjson.decode, raw)
      if not ok then return nil end
      if participant.state ~= 'ADMITTED' then return nil end
      participant.socketId = ARGV[2]
      participant.mic = ARGV[3] == '1' and participant.canSpeak == true or false
      participant.cam = ARGV[4] == '1'
      participant.screen = false
      participant.typing = false
      participant.lastSeenAt = tonumber(ARGV[5])
      redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(participant))
      return cjson.encode(participant)
    `,
    2,
    keys.participants(roomId),
    keys.room(roomId),
    participantId,
    socketId,
    mic ? "1" : "0",
    cam ? "1" : "0",
    Date.now(),
    options.allowLocked ? "1" : "0",
  );
  if (result === null) return null;
  try {
    return parseParticipant(String(result));
  } catch {
    return null;
  }
}

export async function removeParticipant(
  roomId: string,
  participantId: string,
): Promise<void> {
  await getRedis()
    .multi()
    .hdel(keys.participants(roomId), participantId)
    .lrem(keys.queue(roomId), 0, participantId)
    .del(keys.connection(roomId, participantId))
    .exec();
}

export async function setParticipantState(
  roomId: string,
  participantId: string,
  state: ParticipantState,
): Promise<ParticipantRecord | null> {
  return updateParticipant(roomId, participantId, { state });
}

export async function enqueueWaiting(
  roomId: string,
  participantId: string,
): Promise<void> {
  const redis = getRedis();
  await redis
    .multi()
    .lrem(keys.queue(roomId), 0, participantId)
    .rpush(keys.queue(roomId), participantId)
    .expire(keys.queue(roomId), getEnv().roomTtlSeconds)
    .exec();
}

export async function dequeueWaiting(
  roomId: string,
  participantId: string,
): Promise<void> {
  await getRedis().lrem(keys.queue(roomId), 0, participantId);
}

export async function listWaiting(
  roomId: string,
): Promise<ParticipantRecord[]> {
  const ids = await getRedis().lrange(keys.queue(roomId), 0, -1);
  if (ids.length === 0) return [];
  const participants = await Promise.all(
    ids.map((id) => getParticipant(roomId, id)),
  );
  return participants.filter(
    (p): p is ParticipantRecord => p !== null && p.state === "WAITING",
  );
}

export async function appendChat(
  roomId: string,
  message: ChatMessage,
): Promise<void> {
  const redis = getRedis();
  await redis
    .multi()
    .lpush(keys.chat(roomId), JSON.stringify(message))
    .ltrim(keys.chat(roomId), 0, 299)
    .expire(keys.chat(roomId), getEnv().roomTtlSeconds)
    .exec();
}

export async function listChat(
  roomId: string,
  limit = 100,
): Promise<ChatMessage[]> {
  const raw = await getRedis().lrange(keys.chat(roomId), 0, limit - 1);
  return raw
    .map((entry) => {
      try {
        return JSON.parse(entry) as ChatMessage;
      } catch {
        return null;
      }
    })
    .filter((m): m is ChatMessage => m !== null)
    .reverse();
}

export async function endRoom(roomId: string): Promise<RoomRecord | null> {
  return withRoomLock(roomId, async () => {
    const room = await getRoom(roomId);
    if (!room) return null;
    const next: RoomRecord = {
      ...room,
      status: "ended",
      lastActivityAt: Date.now(),
    };
    const keyHash = sha256(room.key);
    const redis = getRedis();
    const tracked = await redis.smembers(keys.roomKeys(roomId));
    const transaction = redis
      .multi()
      .set(keys.room(roomId), JSON.stringify(next), "EX", 600)
      .set(
        keys.ended(keyHash),
        JSON.stringify({ roomId, endedAt: Date.now(), title: room.title }),
        "EX",
        86_400,
      )
      .del(keys.keyLookup(keyHash))
      .srem(keys.activeRooms(), roomId)
      .expire(keys.participants(roomId), 600)
      .expire(keys.files(roomId), 600)
      .expire(keys.chat(roomId), 600);
    // Shorten every tracked room key, including the waiting queue, host token,
    // and key-tracking set. The ended marker below intentionally lives longer.
    for (const trackedKey of tracked) transaction.expire(trackedKey, 600);
    await transaction.exec();
    touchState.delete(roomId);
    return next;
  });
}

export async function purgeRoom(roomId: string): Promise<void> {
  await getRedis()
    .multi()
    .del(keys.room(roomId))
    .del(keys.participants(roomId))
    .del(keys.queue(roomId))
    .del(keys.chat(roomId))
    .del(keys.files(roomId))
    .del(keys.host(roomId))
    .del(keys.roomKeys(roomId))
    .srem(keys.activeRooms(), roomId)
    .exec();
  touchState.delete(roomId);
}

export function nextColor(seed: number): string {
  return pickColor(seed);
}

export type { Role };
