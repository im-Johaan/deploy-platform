import path from 'node:path';
import { config as loadEnv } from 'dotenv';

// Load .env from the repo root regardless of which service is starting.
const repoRoot = new URL('../../../', import.meta.url).pathname;
loadEnv({ path: path.join(repoRoot, '.env'), quiet: true });

function str(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Env var ${name} must be a number, got: ${raw}`);
  }
  return parsed;
}

export const config = {
  redisUrl: str('REDIS_URL', 'redis://localhost:6379'),

  s3: {
    endpoint: str('S3_ENDPOINT', 'http://localhost:9000'),
    accessKey: str('S3_ACCESS_KEY', 'minioadmin'),
    secretKey: str('S3_SECRET_KEY', 'minioadmin'),
    bucket: str('S3_BUCKET', 'deployments'),
    region: str('S3_REGION', 'us-east-1'),
  },

  /** Scratch space for clones and tarballs. Gitignored, safe to wipe. */
  dataDir: str('DATA_DIR', path.join(repoRoot, '.data')),

  uploadPort: int('UPLOAD_PORT', 3001),
  proxyPort: int('PROXY_PORT', 3000),

  /** Base host for generated URLs: `<id>.<rootDomain>` */
  rootDomain: str('ROOT_DOMAIN', 'localhost'),

  /** Scheme for public URLs. Becomes https once TLS terminates in front. */
  publicScheme: str('PUBLIC_SCHEME', 'http'),

  /**
   * Port users reach, which is NOT the port the proxy listens on once it is
   * containerised: in production the proxy listens on 3000 and is published
   * on 80.
   */
  publicPort: int('PUBLIC_PORT', int('PROXY_PORT', 3000)),
} as const;

/**
 * Public URL for a deployment. The port is omitted when it is the default for
 * the scheme, so a VM on :80 yields `http://abc.example.com`, not `...:80`.
 */
export function deploymentUrl(id: string): string {
  const defaultPort = config.publicScheme === 'https' ? 443 : 80;
  const port = config.publicPort === defaultPort ? '' : `:${config.publicPort}`;
  return `${config.publicScheme}://${id}.${config.rootDomain}${port}`;
}
