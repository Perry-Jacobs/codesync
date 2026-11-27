import Redis from "ioredis";
import { getEnv } from "./env";

let client: Redis | null = null;
let subscriber: Redis | null = null;

function create(label: string): Redis {
  const redis = new Redis(getEnv().REDIS_URL, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    connectionName: `codesync:${label}`,
    retryStrategy: (attempt) => Math.min(250 * attempt, 3000),
  });
  redis.on("error", (error: Error) => {
    console.error(`[redis:${label}] ${error.message}`);
  });
  return redis;
}

export function getRedis(): Redis {
  if (!client) client = create("main");
  return client;
}

/** Dedicated connection — a subscribed Redis client cannot run other commands. */
export function getSubscriber(): Redis {
  if (!subscriber) subscriber = create("subscriber");
  return subscriber;
}

export async function closeRedis(): Promise<void> {
  const closing: Promise<unknown>[] = [];
  if (subscriber) {
    closing.push(subscriber.quit());
    subscriber = null;
  }
  if (client) {
    closing.push(client.quit());
    client = null;
  }
  await Promise.allSettled(closing);
}

function key(name: string): string {
  return `${getEnv().REDIS_KEY_PREFIX}${name}`;
}

const room = (roomId: string) => key(`room:${roomId}`);

export const keys = {
  keyLookup: (keyHash: string) => key(`key:${keyHash}`),
  ended: (keyHash: string) => key(`ended:${keyHash}`),
  room,
  roomKeys: (roomId: string) => `${room(roomId)}:keys`,
  participants: (roomId: string) => `${room(roomId)}:participants`,
  queue: (roomId: string) => `${room(roomId)}:queue`,
  chat: (roomId: string) => `${room(roomId)}:chat`,
  files: (roomId: string) => `${room(roomId)}:files`,
  fileIndex: (roomId: string) => `${room(roomId)}:fileIndex`,
  host: (roomId: string) => `${room(roomId)}:host`,
  doc: (roomId: string, fileId: string) => `${room(roomId)}:doc:${fileId}`,
  bus: (roomId: string) => `${room(roomId)}:bus`,
  busPattern: () => key("room:*:bus"),
  fsBus: (roomId: string) => `${room(roomId)}:fs`,
  fsBusPattern: () => key("room:*:fs"),
  fsRequest: (requestId: string) => key(`fs:request:${requestId}`),
  fsResponse: (requestId: string) => key(`fs:response:${requestId}`),
  connection: (roomId: string, participantId: string) =>
    `${room(roomId)}:conn:${participantId}`,
  reconnect: (jti: string) => key(`rt:${jti}`),
  endLock: (roomId: string) => key(`lock:end:${roomId}`),
  createRate: (ipHash: string) => key(`rl:create:${ipHash}`),
  activeRooms: () => key("rooms:active"),
} as const;
