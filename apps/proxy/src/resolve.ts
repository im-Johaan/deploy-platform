import path from 'node:path';

/**
 * Turn a request path into a path relative to the deployment's build prefix.
 *
 * Returns null for anything malformed. The subdomain and the path both come
 * from the request, so this is the one place a crafted path could otherwise
 * cross between deployments.
 */
export function resolveRequestPath(pathname: string): string | null {
  let decoded: string;
  try {
    // Encoded traversal (%2e%2e%2f) has to be decoded before it can be caught.
    decoded = decodeURIComponent(pathname);
  } catch {
    return null; // malformed percent-encoding
  }

  if (decoded.includes('\0')) return null;
  if (!decoded.startsWith('/')) decoded = `/${decoded}`;

  // Reject ".." outright rather than silently normalising it away. No real
  // client-side route contains "..", so a request that does is probing —
  // answering 400 is a clearer signal than quietly serving index.html.
  if (decoded.split('/').some((segment) => segment === '..')) return null;

  // "/docs/" means "/docs/index.html", the usual static-host convention.
  if (decoded.endsWith('/')) decoded += 'index.html';

  // normalize() on an ABSOLUTE path clamps at the root: "/../../etc" -> "/etc".
  // That is what makes escaping the prefix impossible.
  const normalized = path.posix.normalize(decoded);
  if (!normalized.startsWith('/')) return null;

  const relative = normalized.slice(1);
  if (relative.length === 0) return 'index.html';

  // Defence in depth: nothing should survive normalize(), but never emit "..".
  if (relative.split('/').some((segment) => segment === '..')) return null;

  return relative;
}

/**
 * Whether the path names a file rather than a client-side route.
 *
 * "/assets/app.js" is a file — a miss is a real 404.
 * "/about" is a React Router route — a miss must fall back to index.html.
 */
export function looksLikeFile(pathname: string): boolean {
  const lastSegment = pathname.split('/').pop() ?? '';
  return path.posix.extname(lastSegment) !== '';
}

/**
 * Deployments are immutable — a new deploy gets a new id and a new hostname —
 * so assets can be cached indefinitely. HTML stays revalidated so that if an
 * id is ever redeployed in place, clients pick up the new markup.
 */
export function cacheControlFor(relativePath: string): string {
  return relativePath.endsWith('.html')
    ? 'no-cache'
    : 'public, max-age=31536000, immutable';
}
