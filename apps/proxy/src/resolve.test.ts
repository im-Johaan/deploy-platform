import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRequestPath, looksLikeFile, cacheControlFor } from './resolve.js';

test('maps the root and directories to index.html', () => {
  assert.equal(resolveRequestPath('/'), 'index.html');
  assert.equal(resolveRequestPath('/docs/'), 'docs/index.html');
});

test('passes ordinary asset paths through', () => {
  assert.equal(resolveRequestPath('/assets/index-abc123.js'), 'assets/index-abc123.js');
  assert.equal(resolveRequestPath('/build/bundle.css'), 'build/bundle.css');
});

test('decodes percent-encoding', () => {
  assert.equal(resolveRequestPath('/my%20file.png'), 'my file.png');
});

test('rejects traversal instead of normalising it away', () => {
  // Answering 400 is a clearer signal than quietly serving index.html.
  assert.equal(resolveRequestPath('/../../../etc/passwd'), null);
  assert.equal(resolveRequestPath('/a/../../b'), null);
  // ...including when the traversal is percent-encoded, which is why the
  // check runs after decodeURIComponent rather than on the raw path.
  assert.equal(resolveRequestPath('/%2e%2e%2f%2e%2e%2fetc'), null);
  assert.equal(resolveRequestPath('/a/%2e%2e/b'), null);
});

test('a dotfile or a name merely containing dots is still fine', () => {
  assert.equal(resolveRequestPath('/.well-known/acme'), '.well-known/acme');
  assert.equal(resolveRequestPath('/v1.2.3/app.js'), 'v1.2.3/app.js');
  assert.equal(resolveRequestPath('/..foo/bar'), '..foo/bar');
});

test('rejects malformed input', () => {
  assert.equal(resolveRequestPath('/%ZZ'), null);      // bad encoding
  assert.equal(resolveRequestPath('/a%00b'), null);    // NUL byte
});

test('distinguishes files from client-side routes', () => {
  assert.equal(looksLikeFile('/assets/app.js'), true);
  assert.equal(looksLikeFile('/favicon.ico'), true);
  assert.equal(looksLikeFile('/about'), false);        // must fall back to index.html
  assert.equal(looksLikeFile('/users/42/settings'), false);
  assert.equal(looksLikeFile('/'), false);
});

test('caches assets immutably but revalidates html', () => {
  assert.match(cacheControlFor('assets/index-abc.js'), /immutable/);
  assert.equal(cacheControlFor('index.html'), 'no-cache');
});
