/**
 * Input validation — the platform's security boundary.
 *
 * Everything here feeds into `git clone`, a filesystem path, or a Redis key,
 * so each field is checked against an allowlist rather than scanned for
 * "bad" patterns.
 */

export class ValidationError extends Error {
  override readonly name = 'ValidationError';
}

export interface ValidatedDeploy {
  repoUrl: string;
  branch?: string;
  outputDir?: string;
}

// Anchored, and the charset excludes ':' '@' '?' '#' — so credentials in the
// URL, query strings, and fragments are all rejected. Requiring '/' straight
// after "github.com" also blocks lookalikes like github.com.evil.test.
const REPO_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\.git)?$/;

const MAX_URL_LENGTH = 200;
const MAX_BRANCH_LENGTH = 255;
const MAX_OUTPUT_DIR_LENGTH = 100;

export function validateDeployRequest(body: unknown): ValidatedDeploy {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationError('body must be a JSON object');
  }

  const { repoUrl, branch, outputDir } = body as Record<string, unknown>;

  return {
    repoUrl: validateRepoUrl(repoUrl),
    ...(branch === undefined ? {} : { branch: validateBranch(branch) }),
    ...(outputDir === undefined ? {} : { outputDir: validateOutputDir(outputDir) }),
  };
}

export function validateRepoUrl(value: unknown): string {
  if (typeof value !== 'string') throw new ValidationError('repoUrl is required');

  const url = value.trim();
  if (url.length === 0) throw new ValidationError('repoUrl is required');
  if (url.length > MAX_URL_LENGTH) {
    throw new ValidationError(`repoUrl must be at most ${MAX_URL_LENGTH} characters`);
  }
  // JS '$' also matches before a trailing newline, so reject whitespace outright.
  if (/\s/.test(url)) throw new ValidationError('repoUrl must not contain whitespace');

  if (!REPO_URL.test(url)) {
    throw new ValidationError(
      'repoUrl must look like https://github.com/<owner>/<repo>',
    );
  }

  // "https://github.com/./.." would satisfy the charset but is not a real repo.
  const [owner, repo] = url.slice('https://github.com/'.length).split('/');
  for (const segment of [owner, repo]) {
    if (!segment || segment === '.' || segment === '..' || /^\.+$/.test(segment)) {
      throw new ValidationError('repoUrl has an invalid owner or repository name');
    }
  }

  return url;
}

export function validateBranch(value: unknown): string {
  if (typeof value !== 'string') throw new ValidationError('branch must be a string');

  const branch = value.trim();
  if (branch.length === 0) throw new ValidationError('branch must not be empty');
  if (branch.length > MAX_BRANCH_LENGTH) {
    throw new ValidationError(`branch must be at most ${MAX_BRANCH_LENGTH} characters`);
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(branch)) {
    throw new ValidationError('branch contains invalid characters');
  }
  // A leading '-' would be read by git as an option, not a value.
  if (branch.startsWith('-')) {
    throw new ValidationError('branch must not start with "-"');
  }
  // git's own refname rules.
  if (
    branch.includes('..') ||
    branch.startsWith('/') ||
    branch.endsWith('/') ||
    branch.includes('//') ||
    branch.endsWith('.lock') ||
    branch.endsWith('.')
  ) {
    throw new ValidationError('branch is not a valid git ref name');
  }

  return branch;
}

export function validateOutputDir(value: unknown): string {
  if (typeof value !== 'string') throw new ValidationError('outputDir must be a string');

  const dir = value.trim().replace(/\/+$/, '');
  if (dir.length === 0) throw new ValidationError('outputDir must not be empty');
  if (dir.length > MAX_OUTPUT_DIR_LENGTH) {
    throw new ValidationError(`outputDir must be at most ${MAX_OUTPUT_DIR_LENGTH} characters`);
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(dir)) {
    throw new ValidationError('outputDir contains invalid characters');
  }
  if (dir.startsWith('/')) {
    throw new ValidationError('outputDir must be a relative path');
  }
  // Must stay inside the build directory.
  if (dir.split('/').some((segment) => segment === '..')) {
    throw new ValidationError('outputDir must not contain ".."');
  }

  return dir;
}

/** Guard for path params, so a hostile id cannot craft arbitrary Redis keys. */
export function validateDeploymentId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9]{1,32}$/.test(value)) {
    throw new ValidationError('invalid deployment id');
  }
  return value;
}
