import type { Redis } from 'ioredis';
import { keys } from './redis.js';

const MAX_LOG_LINES = 5000;
const LOG_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Append one build-log line: persisted to a capped list (so a reconnecting
 * client can replay history) and published live for SSE subscribers.
 */
export async function appendLog(redis: Redis, id: string, line: string): Promise<void> {
  const entry = `[${new Date().toISOString()}] ${line}`;
  const key = keys.logs(id);

  await redis
    .multi()
    .rpush(key, entry)
    .ltrim(key, -MAX_LOG_LINES, -1)
    .expire(key, LOG_TTL_SECONDS)
    .publish(keys.logEvents(id), entry)
    .exec();
}

export async function readLogs(redis: Redis, id: string): Promise<string[]> {
  return redis.lrange(keys.logs(id), 0, -1);
}
