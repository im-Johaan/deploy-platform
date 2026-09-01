export const DEPLOYMENT_STATUSES = [
  'QUEUED',
  'CLONING',
  'BUILDING',
  'UPLOADING',
  'READY',
  'FAILED',
] as const;

export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number];

export interface Deployment {
  id: string;
  repoUrl: string;
  branch?: string;
  status: DeploymentStatus;
  /** Public URL the site is served at once READY. */
  url: string;
  /** Explicit build output dir, if the caller overrode auto-detection. */
  outputDir?: string;
  /** Populated only when status is FAILED. */
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DeployRequest {
  repoUrl: string;
  branch?: string;
  outputDir?: string;
}
