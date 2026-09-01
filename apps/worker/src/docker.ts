import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class DockerError extends Error {
  override readonly name = 'DockerError';
}

/** Fail fast at boot rather than on the first deployment. */
export async function assertDockerAvailable(): Promise<string> {
  try {
    const { stdout } = await execFileAsync('docker', ['version', '--format', '{{.Server.Version}}']);
    return stdout.trim();
  } catch (err) {
    throw new DockerError(
      `Docker is not available: ${detail(err)}. Is the daemon running?`,
    );
  }
}

export async function imageExists(image: string): Promise<boolean> {
  try {
    await execFileAsync('docker', ['image', 'inspect', image]);
    return true;
  } catch {
    return false;
  }
}

export async function pullImage(image: string, onLine: (l: string) => void): Promise<void> {
  const code = await streamCommand('docker', ['pull', image], onLine);
  if (code !== 0) throw new DockerError(`failed to pull ${image}`);
}

/** Creates a container without starting it, so files can be copied in first. */
export async function createContainer(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('docker', ['create', ...args]);
    return stdout.trim();
  } catch (err) {
    throw new DockerError(`docker create failed: ${detail(err)}`);
  }
}

/** `docker cp <src>/. <cid>:<dest>` — trailing /. copies contents, not the dir. */
export async function copyInto(cid: string, hostDir: string, containerDir: string): Promise<void> {
  try {
    await execFileAsync('docker', ['cp', `${hostDir}/.`, `${cid}:${containerDir}`]);
  } catch (err) {
    throw new DockerError(`docker cp into container failed: ${detail(err)}`);
  }
}

/**
 * Works on stopped containers — which is why the output directory is
 * discovered via a marker file rather than `docker exec`.
 */
export async function copyFrom(cid: string, containerPath: string, hostPath: string): Promise<void> {
  try {
    await execFileAsync('docker', ['cp', `${cid}:${containerPath}`, hostPath], {
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    throw new DockerError(`docker cp from container failed: ${detail(err)}`);
  }
}

/** Starts the container attached, streaming combined output line by line. */
export async function startAttached(
  cid: string,
  onLine: (line: string) => void,
): Promise<number> {
  return streamCommand('docker', ['start', '--attach', cid], onLine);
}

export async function removeContainer(cid: string): Promise<void> {
  try {
    await execFileAsync('docker', ['rm', '--force', '--volumes', cid]);
  } catch {
    // Best effort: a container that is already gone is not an error.
  }
}

/** Spawn a command, emitting whole lines from stdout and stderr as they arrive. */
function streamCommand(
  command: string,
  args: string[],
  onLine: (line: string) => void,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    for (const stream of [child.stdout, child.stderr]) {
      let buffer = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const clean = stripAnsi(line.replace(/\r$/, ''));
          if (clean.trim().length > 0) onLine(clean);
        }
      });
      stream.on('end', () => {
        const clean = stripAnsi(buffer).trim();
        if (clean.length > 0) onLine(clean);
      });
    }

    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

/** Build tools emit colour codes; they are noise once stored in Redis. */
// eslint-disable-next-line no-control-regex
const ANSI = /\u001B\[[0-9;]*[A-Za-z]/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

function detail(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  const stderr = (e?.stderr ?? '').trim();
  return stderr.split('\n')[0]?.trim() || e?.message || 'unknown error';
}
