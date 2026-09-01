import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  createContainer, copyInto, copyFrom, startAttached, removeContainer,
} from './docker.js';
import { planBuild, OUTPUT_CANDIDATES } from './detect.js';

export const BUILD_IMAGE = 'node:22-bookworm-slim';
const BUILD_TIMEOUT_MS = 10 * 60 * 1000;
const CONTAINER_WORKDIR = '/app';

export interface BuildParams {
  /** Extracted repository on the host. */
  sourceDir: string;
  /** Destination for the built output; must not already exist. */
  outputPath: string;
  /** Scratch dir for the marker file. */
  scratchDir: string;
  outputDir?: string;
  log: (line: string) => void;
}

export interface BuildOutcome {
  outputDir: string;
  packageManager: string;
}

/**
 * Build a repository inside a disposable container.
 *
 * Nothing from the repo executes on the host: source is copied in, the build
 * runs on the container's own filesystem, and the output is copied back out.
 * Bind mounts are avoided deliberately — they are slow through Docker's macOS
 * VM, and once this worker is itself containerized a `-v` path would have to
 * be a host path rather than the worker's own.
 */
export async function buildInContainer(params: BuildParams): Promise<BuildOutcome> {
  const { sourceDir, outputPath, scratchDir, outputDir, log } = params;

  await assertBuildable(sourceDir);

  const rootFiles = await readdir(sourceDir);
  const { packageManager, hasLockfile, script } = planBuild(rootFiles, outputDir);
  log(
    `package manager: ${packageManager}` +
      (hasLockfile ? ' (lockfile found)' : ' (no lockfile — resolving fresh)'),
  );
  if (packageManager === 'bun') {
    log('warning: bun is not installed in the build image, falling back to npm');
  }

  const cid = await createContainer([
    '--workdir', CONTAINER_WORKDIR,
    // Resource caps: a runaway build must not be able to wedge the host.
    '--memory', '2g',
    '--memory-swap', '2g',
    '--cpus', '2',
    '--pids-limit', '512',
    '--security-opt', 'no-new-privileges',
    // CI=true keeps build tools non-interactive. NODE_ENV is deliberately NOT
    // set to production: that makes installs skip devDependencies, and the
    // build tool itself (vite, webpack) is almost always a devDependency.
    '--env', 'CI=true',
    '--label', 'adp.build=1',
    BUILD_IMAGE,
    'sh', '-c', script,
  ]);

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void removeContainer(cid);
  }, BUILD_TIMEOUT_MS);

  try {
    await copyInto(cid, sourceDir, CONTAINER_WORKDIR);

    log(`running build in ${BUILD_IMAGE}`);
    const exitCode = await startAttached(cid, log);
    clearTimeout(timer);

    if (timedOut) {
      throw new Error(`build timed out after ${BUILD_TIMEOUT_MS / 60000} minutes`);
    }
    if (exitCode !== 0) {
      throw new Error(`build exited with code ${exitCode}`);
    }

    const produced = await readOutputMarker(cid, scratchDir, outputDir);
    log(`build output directory: ${produced}`);

    await copyFrom(cid, `${CONTAINER_WORKDIR}/${produced}`, outputPath);
    return { outputDir: produced, packageManager };
  } finally {
    clearTimeout(timer);
    // A crashed worker must never leak containers.
    await removeContainer(cid);
  }
}

/** Cheap preflight, so a doomed build fails in milliseconds not minutes. */
async function assertBuildable(sourceDir: string): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(path.join(sourceDir, 'package.json'), 'utf8');
  } catch {
    throw new Error('no package.json at the repository root');
  }

  let pkg: { scripts?: Record<string, string> };
  try {
    pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
  } catch {
    throw new Error('package.json is not valid JSON');
  }

  if (!pkg.scripts?.build) {
    throw new Error('package.json has no "build" script');
  }
}

/**
 * The container writes /app/.outdir naming the directory the build produced.
 * Read it with `docker cp`, which works on a stopped container.
 */
async function readOutputMarker(
  cid: string,
  scratchDir: string,
  requested: string | undefined,
): Promise<string> {
  const markerPath = path.join(scratchDir, 'outdir');

  try {
    await copyFrom(cid, `${CONTAINER_WORKDIR}/.outdir`, markerPath);
  } catch {
    throw new Error(
      requested
        ? `build succeeded but produced no "${requested}" directory`
        : `build succeeded but produced none of: ${OUTPUT_CANDIDATES.join(', ')}`,
    );
  }

  const produced = (await readFile(markerPath, 'utf8')).trim();
  if (!produced) throw new Error('build produced an empty output directory marker');
  return produced;
}
