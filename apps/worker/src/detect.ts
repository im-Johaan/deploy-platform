export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

/**
 * Default output directories, in the order frameworks conventionally use them.
 * `public` is last on purpose: it is an *input* directory for Vite and CRA, so
 * it must only be considered once the real build outputs have been ruled out.
 */
export const OUTPUT_CANDIDATES = ['dist', 'build', 'out', 'public'] as const;

const LOCKFILES: Record<PackageManager, string> = {
  npm: 'package-lock.json',
  pnpm: 'pnpm-lock.yaml',
  yarn: 'yarn.lock',
  bun: 'bun.lockb',
};

export interface BuildPlan {
  packageManager: PackageManager;
  hasLockfile: boolean;
  script: string;
}

/**
 * Pick the package manager from the lockfile committed to the repo.
 * `npm ci` requires package-lock.json and fails outright on a pnpm or yarn repo.
 */
export function detectPackageManager(rootFiles: Iterable<string>): PackageManager {
  const files = new Set(rootFiles);
  if (files.has('pnpm-lock.yaml')) return 'pnpm';
  if (files.has('yarn.lock')) return 'yarn';
  if (files.has('bun.lockb') || files.has('bun.lock')) return 'bun';
  return 'npm';
}

export function planBuild(rootFiles: Iterable<string>, outputDir?: string): BuildPlan {
  const files = new Set(rootFiles);
  const packageManager = detectPackageManager(files);
  const hasLockfile = files.has(LOCKFILES[packageManager]);

  return {
    packageManager,
    hasLockfile,
    script: buildScript(packageManager, hasLockfile, outputDir),
  };
}

function installCommand(pm: PackageManager, hasLockfile: boolean): string {
  switch (pm) {
    case 'pnpm':
      // corepack ships with Node and provisions the right pnpm version.
      return hasLockfile
        ? 'corepack enable && (pnpm install --frozen-lockfile || pnpm install)'
        : 'corepack enable && pnpm install';
    case 'yarn':
      return hasLockfile
        ? 'corepack enable && (yarn install --immutable || yarn install)'
        : 'corepack enable && yarn install';
    case 'bun':
      // The build image has no bun; npm resolves fresh from package.json.
      return 'npm install --no-audit --no-fund';
    case 'npm':
      // Only attempt `npm ci` when a lockfile exists — otherwise it fails with
      // a wall of usage output before the fallback ever runs.
      return hasLockfile
        ? 'npm ci --no-audit --no-fund || npm install --no-audit --no-fund'
        : 'npm install --no-audit --no-fund';
  }
}

function runBuildCommand(pm: PackageManager): string {
  return pm === 'yarn' ? 'yarn build' : `${pm === 'bun' ? 'npm' : pm} run build`;
}

/**
 * The shell script the build container runs.
 *
 * The trailing loop records which output directory the build produced, so the
 * worker can read it with `docker cp` afterwards — `docker exec` cannot be used
 * because the container has already exited by then.
 */
export function buildScript(
  pm: PackageManager,
  hasLockfile: boolean,
  outputDir?: string,
): string {
  const candidates = outputDir ? [outputDir] : [...OUTPUT_CANDIDATES];

  return [
    'set -e',
    installCommand(pm, hasLockfile),
    runBuildCommand(pm),
    // `if` (not `[ -d x ] && ...`) so a non-match returns 0 and does not
    // trip `set -e` on the final loop iteration.
    `for d in ${candidates.join(' ')}; do`,
    '  if [ -d "$d" ]; then printf %s "$d" > /app/.outdir; break; fi',
    'done',
  ].join('\n');
}
