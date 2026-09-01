import { mkdir, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { x as extractTar } from 'tar';
import type { Redis } from 'ioredis';
import {
  config, createRedis, keys, get, storageKeys,
  getDeployment, setStatus, appendLog,
} from '@adp/core';
import { assertDockerAvailable, imageExists, pullImage } from './docker.js';
import { buildInContainer, BUILD_IMAGE } from './build.js';
import { publishDirectory } from './publish.js';

const redis = createRedis();
let running = true;

async function processDeployment(id: string): Promise<void> {
  const deployment = await getDeployment(redis, id);
  if (!deployment) {
    console.warn(`[worker] ${id}: no such deployment record, skipping`);
    return;
  }

  const log = createLogger(redis, id);
  const workRoot = path.join(config.dataDir, 'work', id);
  const sourceDir = path.join(workRoot, 'source');
  const outputPath = path.join(workRoot, 'output');

  try {
    await setStatus(redis, id, 'BUILDING');

    // --- fetch + extract the source snapshot ---
    await rm(workRoot, { recursive: true, force: true });
    await mkdir(sourceDir, { recursive: true });

    const tarball = await get(storageKeys.sourceTarball(id));
    if (!tarball) throw new Error(`source archive ${storageKeys.sourceTarball(id)} is missing`);

    await pipeline(tarball.body, extractTar({ cwd: sourceDir }));
    log.line('extracted source archive');

    // --- build in a disposable container ---
    const outcome = await buildInContainer({
      sourceDir,
      outputPath,
      scratchDir: workRoot,
      ...(deployment.outputDir ? { outputDir: deployment.outputDir } : {}),
      log: log.line,
    });

    // --- publish artifacts ---
    await setStatus(redis, id, 'UPLOADING');
    const published = await publishDirectory(id, outputPath, log.line);

    await setStatus(redis, id, 'READY');
    log.line(
      `READY: ${published.files} files from ${outcome.outputDir}/ — ${deployment.url}`,
    );
    console.log(`[worker] ${id} ready (${published.files} files)`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await setStatus(redis, id, 'FAILED', { error: message });
    log.line(`FAILED: ${message}`);
    console.error(`[worker] ${id} failed: ${message}`);
  } finally {
    await log.flush();
    await rm(workRoot, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Serialises log writes. Docker output arrives through a synchronous callback,
 * so without a chain the appends would race and lines would interleave.
 */
function createLogger(client: Redis, id: string) {
  let chain: Promise<unknown> = Promise.resolve();
  return {
    line(text: string): void {
      chain = chain.then(() => appendLog(client, id, text)).catch(() => {});
    },
    flush(): Promise<unknown> {
      return chain;
    },
  };
}

async function main(): Promise<void> {
  const version = await assertDockerAvailable();
  console.log(`[worker] docker daemon ${version}`);

  if (!(await imageExists(BUILD_IMAGE))) {
    console.log(`[worker] pulling ${BUILD_IMAGE} (first run only)`);
    await pullImage(BUILD_IMAGE, (l) => console.log(`[worker] ${l}`));
  }

  console.log(`[worker] waiting for jobs on ${keys.buildQueue}`);

  // One build at a time: each already consumes 2 CPUs and 2 GB.
  while (running) {
    const job = await redis.blpop(keys.buildQueue, 0);
    if (!job) continue;

    const id = job[1];
    try {
      await processDeployment(id);
    } catch (err) {
      // processDeployment records its own failures; this is a last resort.
      console.error(`[worker] unexpected error on ${id}:`, err);
    }
  }
}

async function shutdown(): Promise<void> {
  running = false;
  await redis.quit();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((err) => {
  console.error('[worker] fatal:', err);
  process.exit(1);
});
