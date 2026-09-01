import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';
import { config } from './config.js';

/**
 * `forcePathStyle` is required for MinIO: the AWS SDK defaults to
 * virtual-host style (bucket.host), which MinIO does not serve locally.
 */
const client = new S3Client({
  endpoint: config.s3.endpoint,
  region: config.s3.region,
  credentials: {
    accessKeyId: config.s3.accessKey,
    secretAccessKey: config.s3.secretKey,
  },
  forcePathStyle: true,
});

/** Object key layout, mirroring the two phases of a deployment. */
export const storageKeys = {
  sourceTarball: (id: string) => `sources/${id}.tar.gz`,
  buildPrefix: (id: string) => `builds/${id}/`,
  buildFile: (id: string, relativePath: string) => `builds/${id}/${relativePath}`,
} as const;

export interface StoredObject {
  body: Readable;
  contentType?: string;
  contentLength?: number;
}

export interface PutOptions {
  contentType?: string;
  /**
   * Required when body is a stream. Without it the SDK falls back to chunked
   * transfer encoding, which MinIO rejects for unsigned payloads.
   */
  contentLength?: number;
}

export async function put(
  key: string,
  body: Buffer | Readable | string,
  opts: PutOptions = {},
): Promise<void> {
  await client.send(
    new PutObjectCommand({
      Bucket: config.s3.bucket,
      Key: key,
      Body: body,
      ContentType: opts.contentType,
      ContentLength: opts.contentLength,
    }),
  );
}

/**
 * Returns null when the object does not exist, rather than throwing — the
 * proxy's SPA fallback depends on telling "missing" apart from "broken".
 */
export async function get(key: string): Promise<StoredObject | null> {
  try {
    const res = await client.send(
      new GetObjectCommand({ Bucket: config.s3.bucket, Key: key }),
    );
    return {
      body: res.Body as Readable,
      contentType: res.ContentType,
      contentLength: res.ContentLength,
    };
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

export async function list(prefix: string): Promise<string[]> {
  const out: string[] = [];
  let token: string | undefined;

  do {
    const res = await client.send(
      new ListObjectsV2Command({
        Bucket: config.s3.bucket,
        Prefix: prefix,
        ContinuationToken: token,
      }),
    );
    for (const obj of res.Contents ?? []) {
      if (obj.Key) out.push(obj.Key);
    }
    token = res.NextContinuationToken;
  } while (token);

  return out;
}

export async function del(key: string): Promise<void> {
  await client.send(new DeleteObjectCommand({ Bucket: config.s3.bucket, Key: key }));
}

function isNotFound(err: unknown): boolean {
  const name = (err as { name?: string })?.name;
  const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata
    ?.httpStatusCode;
  return name === 'NoSuchKey' || name === 'NotFound' || status === 404;
}
