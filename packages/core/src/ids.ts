import { customAlphabet } from 'nanoid';

const DIGITS_AND_LETTERS = 'abcdefghijklmnopqrstuvwxyz0123456789';
const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

/**
 * Subdomains that must never be handed out as deployment ids — a deployment
 * named `api` would shadow our own hostnames.
 */
export const RESERVED_SUBDOMAINS = new Set([
  'api', 'www', 'app', 'admin', 'proxy', 'minio', 'static', 'assets', 'upload', 'worker',
]);

// First char is a letter: DNS labels starting with a digit cause trouble.
const firstChar = customAlphabet(LETTERS, 1);
const rest = customAlphabet(DIGITS_AND_LETTERS, 7);

export function generateDeploymentId(): string {
  for (;;) {
    const id = firstChar() + rest();
    if (!RESERVED_SUBDOMAINS.has(id)) return id;
  }
}

export function isReservedSubdomain(label: string): boolean {
  return RESERVED_SUBDOMAINS.has(label);
}

/**
 * Pull the deployment id out of a Host header.
 *   "abc123xy.localhost:3000" + "localhost" -> "abc123xy"
 *   "localhost:3000"          + "localhost" -> null   (the bare root domain)
 */
export function subdomainFromHost(
  host: string | undefined,
  rootDomain: string,
): string | null {
  if (!host) return null;

  const hostname = host.split(':')[0]?.toLowerCase();
  if (!hostname) return null;

  const suffix = `.${rootDomain.toLowerCase()}`;
  if (!hostname.endsWith(suffix)) return null;

  const label = hostname.slice(0, -suffix.length);
  // Reject empty and multi-level labels ("a.b.localhost").
  if (!label || label.includes('.')) return null;

  return label;
}
