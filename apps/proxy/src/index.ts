import express from 'express';
import type { Request, Response } from 'express';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import mime from 'mime-types';
import {
  config, createRedis, get, storageKeys, getDeployment,
  subdomainFromHost, isReservedSubdomain, deploymentUrl,
} from '@adp/core';
import type { StoredObject } from '@adp/core';
import { resolveRequestPath, looksLikeFile, cacheControlFor } from './resolve.js';

const app = express();
const redis = createRedis();

app.disable('x-powered-by');
// Deployment ids are case-sensitive keys; hostnames are not.
app.set('strict routing', false);

app.get('/health', (req, res, next) => {
  // Only on the bare root domain, so a deployment can serve its own /health.
  if (subdomainFromHost(req.headers.host, config.rootDomain) === null) {
    res.json({ service: 'proxy', ok: true });
    return;
  }
  next();
});

app.use((req, res) => {
  void handle(req, res).catch((err: unknown) => {
    console.error('[proxy] error:', err);
    if (!res.headersSent) sendError(res, 500, 'Internal error');
  });
});

async function handle(req: Request, res: Response): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    sendError(res, 405, 'Only GET and HEAD are supported');
    return;
  }

  const id = subdomainFromHost(req.headers.host, config.rootDomain);
  if (id === null) {
    sendLanding(res);
    return;
  }
  if (isReservedSubdomain(id)) {
    sendError(res, 404, 'Reserved hostname');
    return;
  }

  // --- is this deployment servable? ---
  const deployment = await getDeployment(redis, id);
  if (!deployment) {
    sendError(res, 404, `No deployment named "${id}"`);
    return;
  }
  if (deployment.status === 'FAILED') {
    sendError(res, 502, `Build failed: ${deployment.error ?? 'unknown error'}`);
    return;
  }
  if (deployment.status !== 'READY') {
    res.setHeader('Retry-After', '2');
    sendError(res, 503, `Deployment is ${deployment.status.toLowerCase()}, try again shortly`);
    return;
  }

  // --- resolve to an object key ---
  const relative = resolveRequestPath(req.path);
  if (relative === null) {
    sendError(res, 400, 'Malformed request path');
    return;
  }

  const object = await get(storageKeys.buildFile(id, relative));
  if (object) {
    await send(req, res, object, relative, id, 200);
    return;
  }

  // --- SPA fallback ---
  // A miss on a path with no file extension is a client-side route: serve
  // index.html with 200, not 404, or every deep link and refresh breaks.
  if (!looksLikeFile(req.path)) {
    const indexHtml = await get(storageKeys.buildFile(id, 'index.html'));
    if (indexHtml) {
      await send(req, res, indexHtml, 'index.html', id, 200);
      return;
    }
  }

  sendError(res, 404, `Not found: ${req.path}`);
}

async function send(
  req: Request,
  res: Response,
  object: StoredObject,
  relativePath: string,
  id: string,
  status: number,
): Promise<void> {
  res.status(status);
  res.setHeader('Content-Type', contentTypeFor(object, relativePath));
  res.setHeader('Cache-Control', cacheControlFor(relativePath));
  res.setHeader('X-Deployment-Id', id);
  if (object.contentLength !== undefined) {
    res.setHeader('Content-Length', String(object.contentLength));
  }

  if (req.method === 'HEAD') {
    object.body.destroy();
    res.end();
    return;
  }

  try {
    await pipeline(object.body, res);
  } catch {
    // Client disconnected mid-stream; headers are already sent.
    res.destroy();
  }
}

/**
 * Prefer the Content-Type the worker stamped at upload. Fall back to the
 * extension so objects written by an older worker still render correctly
 * rather than downloading as octet-stream.
 */
function contentTypeFor(object: StoredObject, relativePath: string): string {
  const stored = object.contentType;
  if (stored && stored !== 'application/octet-stream') return stored;
  return mime.contentType(path.basename(relativePath)) || 'application/octet-stream';
}

function sendError(res: Response, status: number, message: string): void {
  res.status(status).type('text/html').send(page(String(status), message));
}

function sendLanding(res: Response): void {
  res.status(200).type('text/html').send(
    page(
      'Deployment platform',
      `POST a repository to the upload service, then open ` +
        `<code>${deploymentUrl('&lt;id&gt;')}</code>.`,
    ),
  );
}

function page(heading: string, message: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${heading}</title>
<style>body{font:16px/1.6 system-ui,sans-serif;margin:15vh auto;max-width:34rem;padding:0 1.5rem;color:#111}
h1{font-size:1.4rem;margin:0 0 .4rem}p{color:#555;margin:0}code{background:#f4f4f5;padding:.15em .4em;border-radius:4px}
@media(prefers-color-scheme:dark){body{background:#111;color:#eee}p{color:#aaa}code{background:#222}}</style>
<h1>${heading}</h1><p>${message}</p>`;
}

app.listen(config.proxyPort, () => {
  console.log(`[proxy] listening on http://localhost:${config.proxyPort}`);
  console.log(`[proxy] deployments served at ${deploymentUrl('<id>')}`);
});

async function shutdown() {
  await redis.quit();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
