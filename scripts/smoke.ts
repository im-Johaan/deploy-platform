/**
 * Infra smoke test: proves config, MinIO and Redis are wired up correctly.
 *   npm run smoke
 */
import {
  config, createRedis, keys, put, get, list, del, storageKeys,
  generateDeploymentId, subdomainFromHost,
} from '@adp/core';

const id = generateDeploymentId();
console.log('generated id:       ', id);
console.log('subdomain parse:    ', subdomainFromHost(`${id}.localhost:3000`, 'localhost'));
console.log('root domain parse:  ', subdomainFromHost('localhost:3000', 'localhost'), '(expect null)');
console.log('nested host parse:  ', subdomainFromHost('a.b.localhost:3000', 'localhost'), '(expect null)');

// --- MinIO round trip ---
const key = storageKeys.buildFile(id, 'index.html');
await put(key, '<h1>hello</h1>', { contentType: 'text/html' });

const obj = await get(key);
const body = obj ? await new Response(obj.body as never).text() : null;
console.log('s3 put/get:         ', JSON.stringify(body), '| contentType:', obj?.contentType);
console.log('s3 missing key:     ', await get(storageKeys.buildFile(id, 'nope.html')), '(expect null)');
console.log('s3 list prefix:     ', await list(storageKeys.buildPrefix(id)));

// --- Redis round trip ---
const redis = createRedis();
await redis.hset(keys.deployment(id), { id, status: 'QUEUED' });
console.log('redis hgetall:      ', await redis.hgetall(keys.deployment(id)));
await redis.lpush(keys.buildQueue, id);
console.log('redis blpop:        ', await redis.blpop(keys.buildQueue, 1));
await redis.del(keys.deployment(id));
await redis.quit();

console.log('\nconfig:', { redis: config.redisUrl, s3: config.s3.endpoint, bucket: config.s3.bucket });
await del(key);
console.log('smoke test passed.');
