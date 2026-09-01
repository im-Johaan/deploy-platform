import { readdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import mime from 'mime-types';
import { put, storageKeys } from '@adp/core';

const UPLOAD_CONCURRENCY = 8;

export interface PublishResult {
  files: number;
  bytes: number;
  hasIndexHtml: boolean;
}

interface Artifact {
  absolutePath: string;
  relativePath: string;
  size: number;
}

/**
 * Upload a built directory to `builds/<id>/**`.
 *
 * Content-Type is stamped here rather than computed at request time: served
 * without it, browsers refuse to execute .js with "Refused to execute script
 * because of its MIME type" and the page renders blank.
 */
export async function publishDirectory(
  id: string,
  outputPath: string,
  log: (line: string) => void,
): Promise<PublishResult> {
  const artifacts = await collectFiles(outputPath);

  if (artifacts.length === 0) {
    throw new Error('build output directory is empty');
  }

  const bytes = artifacts.reduce((sum, a) => sum + a.size, 0);
  log(`uploading ${artifacts.length} files (${mb(bytes)} MB)`);

  await inParallel(artifacts, UPLOAD_CONCURRENCY, async (artifact) => {
    const key = storageKeys.buildFile(id, artifact.relativePath);
    // contentType (not lookup) appends "; charset=utf-8" for text types.
    const contentType =
      mime.contentType(path.basename(artifact.relativePath)) || 'application/octet-stream';

    await put(key, createReadStream(artifact.absolutePath), {
      contentType,
      contentLength: artifact.size,
    });
  });

  const hasIndexHtml = artifacts.some((a) => a.relativePath === 'index.html');
  if (!hasIndexHtml) {
    log('warning: no index.html at the output root — "/" will 404');
  }

  return { files: artifacts.length, bytes, hasIndexHtml };
}

async function collectFiles(root: string): Promise<Artifact[]> {
  const found: Artifact[] = [];

  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
      } else if (entry.isFile()) {
        // POSIX separators: these become object keys and URL paths.
        const relativePath = path.relative(root, absolutePath).split(path.sep).join('/');
        found.push({ absolutePath, relativePath, size: (await stat(absolutePath)).size });
      }
    }
  };

  await walk(root);
  return found;
}

/** Bounded parallelism: uploads are IO-bound, but not unbounded. */
async function inParallel<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      if (item !== undefined) await fn(item);
    }
  });
  await Promise.all(workers);
}

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}
