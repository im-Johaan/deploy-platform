import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateRepoUrl, validateBranch, validateOutputDir,
  validateDeploymentId, validateDeployRequest, ValidationError,
} from './validate.js';

const rejects = (fn: () => unknown, why: string) =>
  assert.throws(fn, ValidationError, why);

test('accepts ordinary GitHub URLs', () => {
  for (const url of [
    'https://github.com/vitejs/vite',
    'https://github.com/vitejs/vite.git',
    'https://github.com/some-user/my_repo.v2',
  ]) {
    assert.equal(validateRepoUrl(url), url);
  }
  assert.equal(validateRepoUrl('  https://github.com/a/b  '), 'https://github.com/a/b');
});

test('rejects non-GitHub and malformed URLs', () => {
  for (const url of [
    'http://github.com/a/b',              // not https
    'https://gitlab.com/a/b',             // wrong host
    'https://github.com.evil.test/a/b',   // lookalike host
    'https://user:pass@github.com/a/b',   // embedded credentials
    'git@github.com:a/b.git',             // ssh
    'https://github.com/a',               // no repo
    'https://github.com/a/b/c',           // too deep
    'https://github.com/a/b?x=1',         // query string
    'https://github.com/a/b#frag',        // fragment
    'https://github.com/./..',            // dot segments
    'file:///etc/passwd',
    '',
  ]) {
    rejects(() => validateRepoUrl(url), `should reject ${url}`);
  }
});

test('rejects a URL with a trailing newline', () => {
  // JS '$' matches before a trailing newline — this must not slip through.
  rejects(() => validateRepoUrl('https://github.com/a/b\nrm -rf /'), 'newline');
});

test('rejects branches that could be read as git options', () => {
  assert.equal(validateBranch('main'), 'main');
  assert.equal(validateBranch('feature/new-ui'), 'feature/new-ui');

  for (const branch of ['--upload-pack=sh', '-x', 'a..b', '/main', 'main/', 'a//b', 'x.lock', '']) {
    rejects(() => validateBranch(branch), `should reject ${branch}`);
  }
});

test('rejects outputDir escaping the build directory', () => {
  assert.equal(validateOutputDir('dist'), 'dist');
  assert.equal(validateOutputDir('packages/web/dist/'), 'packages/web/dist');

  for (const dir of ['../etc', 'a/../../b', '/etc/passwd', '']) {
    rejects(() => validateOutputDir(dir), `should reject ${dir}`);
  }
});

test('rejects deployment ids that are not plain slugs', () => {
  assert.equal(validateDeploymentId('abc123xy'), 'abc123xy');
  for (const id of ['../other', 'dep:*', 'UPPER', '']) {
    rejects(() => validateDeploymentId(id), `should reject ${id}`);
  }
});

test('validateDeployRequest omits absent optional fields', () => {
  const parsed = validateDeployRequest({ repoUrl: 'https://github.com/a/b' });
  assert.deepEqual(parsed, { repoUrl: 'https://github.com/a/b' });
  assert.ok(!('branch' in parsed), 'branch key must be absent, not undefined');
});

test('rejects non-object bodies', () => {
  for (const body of [null, 'string', 42, ['a']]) {
    rejects(() => validateDeployRequest(body), `should reject ${JSON.stringify(body)}`);
  }
});
