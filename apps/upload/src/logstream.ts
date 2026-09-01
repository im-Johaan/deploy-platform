import type { Request, Response } from 'express';
import type { Redis } from 'ioredis';
import { createRedis, keys, readLogs, getDeployment } from '@adp/core';
import type { DeploymentStatus } from '@adp/core';

const TERMINAL: ReadonlySet<DeploymentStatus> = new Set<DeploymentStatus>(['READY', 'FAILED']);
const STATUS_POLL_MS = 2_000;
const HEARTBEAT_MS = 15_000;

export function wantsEventStream(req: Request): boolean {
  return (req.headers.accept ?? '').includes('text/event-stream');
}

/**
 * Stream build logs as Server-Sent Events.
 *
 * History is replayed from the capped list first, then live lines arrive over
 * pub/sub — so a client that connects mid-build still sees the whole log.
 */
export async function streamLogs(
  redis: Redis,
  req: Request,
  res: Response,
  id: string,
): Promise<void> {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Tells nginx and friends not to buffer the stream.
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  // A subscribed ioredis connection cannot issue ordinary commands, so the
  // subscriber has to be its own client.
  let subscriber: Redis | null = null;
  let statusTimer: NodeJS.Timeout | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let closed = false;

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    if (statusTimer) clearInterval(statusTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    void subscriber?.quit().catch(() => {});
    res.end();
  };

  // Client navigated away or hung up.
  req.on('close', cleanup);

  const finish = (status: DeploymentStatus): void => {
    if (closed) return;
    send(res, 'status', status);
    send(res, 'end', status);
    cleanup();
  };

  // --- replay history ---
  for (const line of await readLogs(redis, id)) {
    send(res, 'log', line);
  }

  // Already finished before we subscribed: nothing more will be published.
  const initial = await getDeployment(redis, id);
  if (!initial) return finish('FAILED');
  send(res, 'status', initial.status);
  if (TERMINAL.has(initial.status)) return finish(initial.status);
  let lastStatus: DeploymentStatus = initial.status;

  // --- live lines ---
  subscriber = createRedis();
  subscriber.on('message', (_channel: string, message: string) => {
    if (!closed) send(res, 'log', message);
  });
  await subscriber.subscribe(keys.logEvents(id));

  // The status lives in a hash, not the log stream, so poll it to know when
  // to close rather than pattern-matching log text.
  statusTimer = setInterval(() => {
    void (async () => {
      const current = await getDeployment(redis, id);
      if (!current) return finish('FAILED');

      // Push every transition (CLONING -> QUEUED -> BUILDING -> UPLOADING),
      // not just the terminal one, so a client's status display stays honest.
      if (current.status !== lastStatus) {
        lastStatus = current.status;
        if (!TERMINAL.has(current.status)) send(res, 'status', current.status);
      }
      if (TERMINAL.has(current.status)) finish(current.status);
    })();
  }, STATUS_POLL_MS);

  // Comment frames keep idle connections alive through intermediaries.
  heartbeatTimer = setInterval(() => {
    if (!closed) res.write(': heartbeat\n\n');
  }, HEARTBEAT_MS);
}

/** SSE frame. Multi-line payloads need `data:` on every line. */
function send(res: Response, event: string, data: string): void {
  const lines = data.split('\n').map((line) => `data: ${line}`).join('\n');
  res.write(`event: ${event}\n${lines}\n\n`);
}
