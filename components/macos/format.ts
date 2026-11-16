/**
 * Pure helpers for the macOS dashboard (no React), unit tested.
 */

import type { MacosJob, MacosJobStatus } from '@/lib/macos/types';
import { MACOS_ACTIVE_JOB_STATUSES } from '@/lib/macos/types';

export function isJobActive(job: Pick<MacosJob, 'status'>): boolean {
  return MACOS_ACTIVE_JOB_STATUSES.includes(job.status);
}

export function hasActiveJobs(jobs: Pick<MacosJob, 'status'>[]): boolean {
  return jobs.some(isJobActive);
}

export const JOB_STATUS_LABELS: Record<MacosJobStatus, string> = {
  queued: 'Queued',
  downloading: 'Preparing',
  uploading: 'Uploading',
  committing: 'Committing',
  assigning: 'Assigning',
  completed: 'Completed',
  failed: 'Failed',
};

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return 'never';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

/** Readable HTTP error from an API JSON body. */
export async function readApiError(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === 'string' && body.error) return body.error;
  } catch {
    // ignore
  }
  return `${fallback} (${response.status})`;
}
