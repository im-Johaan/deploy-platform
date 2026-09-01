import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rm, readdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import type { Redis } from 'ioredis';
import { create as createTar } from 'tar';
import {
  config, keys, put, storageKeys, setStatus, appendLog,
} from '@adp/core';
import type { Deployment } from '@adp/core';

const execFileAsync = promisify(execFile);

const CLONE_TIMEOUT_MS = 60_000;
const MAX_SOURCE_BYTES = 500 * 1024 * 1024; // 500 MB
/** Never shipped to the builder: history and any committed dependencies. */
const EXCLUDED_DIRS = new Set(['.git', 'node_modules']);

/**
 * Snapshot a repository into object storage and queue it for building.
 *
 * Runs in the background — /deploy has already responded by this point, so
 * failures are reported through the deployment record, never thrown to a caller.
 */
export async function runUploadPipeline(
  redis: Redis,
  deployment: Deployment,
): Promise<void> {
  const { id, repoUrl, branch } = deployment;
  const sourcesDir = path.join(config.dataDir, 'sources');
  const workDir = path.join(sourcesDir, id);
  const tarPath = path.join(sourcesDir, `${id}.tar.gz`);

  try {
    await mkdir(sourcesDir, { recursive: true });
    await rm(workDir, { recursive: true, force: true });

    await appendLog(redis, id, `cloning ${repoUrl}${branch ? ` (branch ${branch})` : ''}`);
    await cloneRepo(repoUrl, branch, workDir);

    const bytes = await directorySize(workDir);
    if (bytes > MAX_SOURCE_BYTES) {
      throw new Error(
        `source is ${mb(bytes)} MB, exceeds the ${mb(MAX_SOURCE_BYTES)} MB limit`,
      );
    }
    await appendLog(redis, id, `cloned, ${mb(bytes)} MB of source`);

    await createTarball(workDir, tarPath);
    const { size } = await stat(tarPath);
    await appendLog(redis, id, `packed archive, ${mb(size)} MB`);

    await put(storageKeys.sourceTarball(id), createReadStream(tarPath), {
      contentType: 'application/gzip',
      contentLength: size,
    });
    await appendLog(redis, id, `uploaded ${storageKeys.sourceTarball(id)}`);

    // Mark QUEUED before enqueueing, and enqueue LAST — a worker must never
    // pop an id whose tarball is not yet readable from storage.
    await setStatus(redis, id, 'QUEUED');
    await redis.lpush(keys.buildQueue, id);
    await appendLog(redis, id, 'queued for build');
  } catch (err) {
    const message = errorMessage(err);
    await setStatus(redis, id, 'FAILED', { error: message });
    await appendLog(redis, id, `FAILED: ${message}`);
    console.error(`[upload] ${id} failed:`, message);
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
    await rm(tarPath, { force: true }).catch(() => {});
  }
}

async function cloneRepo(
  repoUrl: string,
  branch: string | undefined,
  destination: string,
): Promise<void> {
  const args = [
    'clone',
    '--depth', '1',
    '--single-branch',
    ...(branch ? ['--branch', branch] : []),
    // '--' ends option parsing: a URL beginning with '-' can never be read
    // as a flag, even if validation were bypassed.
    '--',
    repoUrl,
    destination,
  ];

  try {
    // execFile, not exec: no shell is spawned, so the URL cannot be interpreted
    // as a command regardless of its contents.
    await execFileAsync('git', args, {
      timeout: CLONE_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
      env: {
        ...process.env,
        // Without this a private or missing repo blocks forever on a
        // username prompt instead of failing.
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_NOSYSTEM: '1',
      },
    });
  } catch (err) {
    throw new Error(`git clone failed: ${gitErrorDetail(err)}`);
  }
}

async function createTarball(sourceDir: string, tarPath: string): Promise<void> {
  await createTar(
    {
      gzip: true,
      file: tarPath,
      cwd: sourceDir,
      portable: true,
      filter: (entryPath) =>
        !entryPath.split('/').some((segment) => EXCLUDED_DIRS.has(segment)),
    },
    ['.'],
  );
}

/** Size of what will actually be archived, so excluded dirs don't count. */
async function directorySize(dir: string): Promise<number> {
  let total = 0;

  const walk = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        total += (await stat(full)).size;
      }
      // Symlinks are counted as zero and archived as links, not followed.
    }
  };

  await walk(dir);
  return total;
}

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** git puts the useful part on stderr; surface its first meaningful line. */
function gitErrorDetail(err: unknown): string {
  const e = err as { stderr?: string; killed?: boolean; message?: string };
  if (e?.killed) return `timed out after ${CLONE_TIMEOUT_MS / 1000}s`;

  const stderr = (e?.stderr ?? '').trim();
  const line = stderr
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith('Cloning into'));

  return line ?? e?.message ?? 'unknown error';
}
