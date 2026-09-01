import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectPackageManager, buildScript, planBuild } from './detect.js';

test('detects the package manager from the lockfile', () => {
  assert.equal(detectPackageManager(['package.json']), 'npm');
  assert.equal(detectPackageManager(['package-lock.json']), 'npm');
  assert.equal(detectPackageManager(['pnpm-lock.yaml']), 'pnpm');
  assert.equal(detectPackageManager(['yarn.lock']), 'yarn');
  assert.equal(detectPackageManager(['bun.lockb']), 'bun');
});

test('uses npm ci only when a lockfile is present', () => {
  const withLock = planBuild(['package.json', 'package-lock.json']);
  assert.equal(withLock.hasLockfile, true);
  assert.match(withLock.script, /npm ci --no-audit --no-fund \|\| npm install/);

  // Without this check npm ci fails with a wall of usage output first.
  const withoutLock = planBuild(['package.json']);
  assert.equal(withoutLock.hasLockfile, false);
  assert.ok(!withoutLock.script.includes('npm ci'), 'must not attempt npm ci');
  assert.match(withoutLock.script, /npm install --no-audit --no-fund/);
});

test('probes dist, build, out, then public', () => {
  // public is last: it is an input directory for Vite and CRA.
  assert.match(planBuild(['package.json']).script, /for d in dist build out public; do/);
});

test('an explicit outputDir replaces the candidate list', () => {
  assert.match(planBuild(['package.json'], 'packages/web/dist').script,
    /for d in packages\/web\/dist; do/);
});

test('output detection uses if, not && — so set -e cannot kill the loop', () => {
  // `[ -d "$d" ] && ...` returns 1 on the final non-matching iteration,
  // which `set -e` would treat as a build failure.
  const script = buildScript('npm', true);
  assert.ok(!/\[ -d "\$d" \] &&/.test(script), 'must not use the && form');
  assert.match(script, /if \[ -d "\$d" \]; then/);
});

test('pnpm and yarn go through corepack', () => {
  assert.match(planBuild(['pnpm-lock.yaml']).script, /corepack enable && \(pnpm install --frozen-lockfile/);
  assert.match(planBuild(['yarn.lock']).script, /corepack enable && \(yarn install --immutable/);
  assert.match(planBuild(['yarn.lock']).script, /^yarn build$/m);
});

test('never sets NODE_ENV=production in the script', () => {
  // It would make installs skip devDependencies — where the build tool lives.
  assert.ok(!planBuild(['package.json']).script.includes('NODE_ENV'));
});
