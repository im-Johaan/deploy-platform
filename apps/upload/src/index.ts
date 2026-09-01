import express from 'express';
import { fileURLToPath } from 'node:url';
import type { Request, Response, NextFunction } from 'express';
import {
  config, createRedis, createDeployment, getDeployment, readLogs,
  generateDeploymentId, deploymentUrl, subdomainFromHost, isReservedSubdomain,
} from '@adp/core';
import { runUploadPipeline } from './pipeline.js';
import { streamLogs, wantsEventStream } from './logstream.js';
import {
  validateDeployRequest, validateDeploymentId, ValidationError,
} from './validate.js';

const app = express();
const redis = createRedis();

app.use(express.json({ limit: '16kb' }));

// express.json throws on malformed bodies; answer 400 rather than 500.
app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({ error: 'request body is not valid JSON' });
    return;
  }
  next(err);
});

app.get('/health', (_req, res) => {
  res.json({ service: 'upload', ok: true });
});

/**
 * Caddy's on-demand TLS gate.
 *
 * Before issuing a certificate for a hostname, Caddy asks here whether it is
 * legitimate. Without this check anyone could request random subdomains and
 * exhaust the Let's Encrypt rate limit (50 certs/week per registered domain).
 * Answer 200 only for hostnames that map to a real deployment.
 */
app.get('/tls-check', asyncHandler(async (req, res) => {
  const domain = typeof req.query.domain === 'string' ? req.query.domain : '';
  const id = subdomainFromHost(domain, config.rootDomain);

  if (id && !isReservedSubdomain(id) && (await getDeployment(redis, id))) {
    res.sendStatus(200);
    return;
  }
  res.sendStatus(404);
}));

// Minimal web UI. Same origin as the API, so no CORS handling is needed.
app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));

/**
 * Start a deployment.
 *
 * Responds as soon as the record exists — cloning can take tens of seconds,
 * so the caller gets an id and polls, rather than holding the connection open.
 */
app.post('/deploy', asyncHandler(async (req, res) => {
  const input = validateDeployRequest(req.body);

  const id = generateDeploymentId();
  const url = deploymentUrl(id);

  const deployment = await createDeployment(redis, {
    id,
    repoUrl: input.repoUrl,
    status: 'CLONING',
    url,
    ...(input.branch === undefined ? {} : { branch: input.branch }),
    ...(input.outputDir === undefined ? {} : { outputDir: input.outputDir }),
  });

  console.log(`[upload] ${id} <- ${input.repoUrl}`);

  res.status(202).json({
    id,
    url,
    status: deployment.status,
    statusUrl: `/status/${id}`,
    logsUrl: `/logs/${id}`,
  });

  // Deliberately not awaited: the response is already sent. The pipeline
  // records its own failures on the deployment record.
  void runUploadPipeline(redis, deployment);
}));

app.get('/status/:id', asyncHandler(async (req, res) => {
  const id = validateDeploymentId(req.params.id);
  const deployment = await getDeployment(redis, id);

  if (!deployment) {
    res.status(404).json({ error: 'no such deployment', id });
    return;
  }
  res.json(deployment);
}));

/**
 * Build logs. Streams as Server-Sent Events when the client asks for them
 * (`Accept: text/event-stream`), otherwise returns the accumulated lines.
 */
app.get('/logs/:id', asyncHandler(async (req, res) => {
  const id = validateDeploymentId(req.params.id);
  const deployment = await getDeployment(redis, id);

  if (!deployment) {
    res.status(404).json({ error: 'no such deployment', id });
    return;
  }

  if (wantsEventStream(req)) {
    await streamLogs(redis, req, res, id);
    return;
  }
  res.json({ id, status: deployment.status, logs: await readLogs(redis, id) });
}));

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ValidationError) {
    res.status(400).json({ error: err.message });
    return;
  }
  console.error('[upload] unhandled error:', err);
  res.status(500).json({ error: 'internal error' });
});

/** Express 4 does not catch rejected promises from handlers. */
function asyncHandler(
  fn: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

app.listen(config.uploadPort, () => {
  console.log(`[upload] listening on http://localhost:${config.uploadPort}`);
});

async function shutdown() {
  await redis.quit();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
