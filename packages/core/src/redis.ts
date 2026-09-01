import Redis from 'ioredis';
import { config } from './config.js';

/**
 * Every Redis key the platform uses, in one place.
 *
 *   dep:<id>          HASH  the deployment record
 *   build:queue       LIST  LPUSH by upload, BLPOP by worker
 *   logs:<id>         LIST  accumulated build output (replayed on connect)
 *   logs:<id>:events  CHAN  pub/sub for live streaming
 */
export const keys = {
  deployment: (id: string) => `dep:${id}`,
  buildQueue: 'build:queue',
  logs: (id: string) => `logs:${id}`,
  logEvents: (id: string) => `logs:${id}:events`,
} as const;

/**
 * `maxRetriesPerRequest: null` is required for blocking commands (BLPOP) —
 * without it ioredis aborts the command after the default retry budget.
 */
export function createRedis(): Redis {
  return new Redis(config.redisUrl, { maxRetriesPerRequest: null });
}
