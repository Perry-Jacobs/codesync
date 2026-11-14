import { getRedis, keys } from "@/lib/redis";
import { createLogger } from "../logger";

const log = createLogger({ scope: "sweeper" });

/**
 * Redis TTLs do the real cleanup; this only trims the active-room index so it
 * does not grow forever. Runs every five minutes and never blocks startup.
 */
export function startRoomSweeper(intervalMs = 5 * 60_000): () => void {
  const timer = setInterval(() => {
    void (async () => {
      try {
        const redis = getRedis();
        const roomIds = await redis.smembers(keys.activeRooms());
        if (roomIds.length === 0) return;
        const pipeline = redis.pipeline();
        for (const roomId of roomIds) pipeline.exists(keys.room(roomId));
        const results = await pipeline.exec();
        const stale: string[] = [];
        results?.forEach(([error, value], index) => {
          if (error) return;
          if (value === 0) stale.push(roomIds[index] as string);
        });
        if (stale.length > 0) {
          await redis.srem(keys.activeRooms(), ...stale);
          log.info("pruned expired rooms", { count: stale.length });
        }
      } catch (error) {
        log.warn("sweep failed", { error: String(error) });
      }
    })();
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
