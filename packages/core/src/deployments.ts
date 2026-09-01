import type { Redis } from 'ioredis';
import { keys } from './redis.js';
import type { Deployment, DeploymentStatus } from './types.js';

/** Records expire so Redis doesn't grow without bound. */
const RECORD_TTL_SECONDS = 7 * 24 * 60 * 60;

export type NewDeployment = Omit<Deployment, 'createdAt' | 'updatedAt'>;

export async function createDeployment(
  redis: Redis,
  input: NewDeployment,
): Promise<Deployment> {
  const now = new Date().toISOString();
  const record: Deployment = { ...input, createdAt: now, updatedAt: now };

  const key = keys.deployment(record.id);
  await redis.hset(key, toHash(record));
  await redis.expire(key, RECORD_TTL_SECONDS);

  return record;
}

export async function getDeployment(
  redis: Redis,
  id: string,
): Promise<Deployment | null> {
  const raw = await redis.hgetall(keys.deployment(id));
  if (Object.keys(raw).length === 0) return null;
  return raw as unknown as Deployment;
}

/** Partial update; always refreshes updatedAt. */
export async function updateDeployment(
  redis: Redis,
  id: string,
  patch: Partial<Deployment>,
): Promise<void> {
  const hash = toHash({ ...patch, updatedAt: new Date().toISOString() });
  if (Object.keys(hash).length === 0) return;
  await redis.hset(keys.deployment(id), hash);
}

export async function setStatus(
  redis: Redis,
  id: string,
  status: DeploymentStatus,
  extra?: Partial<Deployment>,
): Promise<void> {
  await updateDeployment(redis, id, { ...extra, status });
}

/**
 * Redis hashes hold strings only, and ioredis rejects undefined values —
 * so absent optional fields must be dropped rather than written as "undefined".
 */
function toHash(obj: object): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null) out[k] = String(v);
  }
  return out;
}
