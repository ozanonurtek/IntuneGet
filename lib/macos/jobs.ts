/**
 * In-process deploy queue for macOS apps: one job at a time (single replica,
 * uploads are heavy). Jobs left non-terminal by a previous process are failed
 * when the store first opens (see ensureMacosSchema).
 */

import { getServicePrincipalToken } from '@/lib/intune/graph-client';
import { logoUrl } from './catalog';
import { MacosGraphClient } from './graph';
import { deployMacosApp, type DeployResult } from './intune-upload';
import { getCatalogApp, getJob, insertJob, updateJob, type NewJobInput } from './store';
import type { MacosJob } from './types';

export type MacosJobExecutor = (job: MacosJob) => Promise<DeployResult>;

interface QueueState {
  queue: string[];
  running: boolean;
  executor: MacosJobExecutor | null;
  idle: Promise<void>;
  resolveIdle: (() => void) | null;
}

const QUEUE_KEY = Symbol.for('intuneget.macos.jobQueue');
function queueState(): QueueState {
  const g = globalThis as unknown as Record<symbol, QueueState | undefined>;
  if (!g[QUEUE_KEY]) g[QUEUE_KEY] = { queue: [], running: false, executor: null, idle: Promise.resolve(), resolveIdle: null };
  return g[QUEUE_KEY]!;
}

/** Tests replace the executor; null restores the real Intune deploy. */
export function setMacosJobExecutorForTests(executor: MacosJobExecutor | null): void {
  queueState().executor = executor;
}

/** Resolves once the queue has drained (tests). */
export function waitForMacosQueueIdle(): Promise<void> {
  return queueState().idle;
}

export function createGraphClientForTenant(tenantId: string): MacosGraphClient {
  return new MacosGraphClient(() => getServicePrincipalToken(tenantId));
}

const defaultExecutor: MacosJobExecutor = async (job) => {
  const app = getCatalogApp(job.catalogId);
  if (!app) throw new Error('The app is no longer in the macOS catalog.');
  return deployMacosApp(
    {
      app,
      mode: job.mode,
      intuneAppId: job.intuneAppId,
      assignments: job.assignments,
      ignoreVersionDetection: job.ignoreVersionDetection,
      logoUrl: logoUrl(app.id),
    },
    {
      graph: createGraphClientForTenant(job.tenantId),
      onStatus: (status, percent) => updateJob(job.id, { status, progressPercent: percent }),
      onAppCreated: (intuneAppId) => updateJob(job.id, { intuneAppId }),
    }
  );
};

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 2000) || 'Deployment failed';
}

async function runJob(id: string, executor: MacosJobExecutor): Promise<void> {
  const job = getJob(id);
  if (!job || job.status !== 'queued') return;
  try {
    const result = await executor(job);
    updateJob(id, {
      status: 'completed',
      progressPercent: 100,
      intuneAppId: result.intuneAppId,
      errorMessage: result.warnings.length ? result.warnings.join(' ') : null,
    });
  } catch (error) {
    console.error(`[macos] job ${id} (${job.catalogId}) failed:`, errorText(error));
    updateJob(id, { status: 'failed', errorMessage: errorText(error) });
  }
}

async function drain(): Promise<void> {
  const s = queueState();
  if (s.running) return;
  s.running = true;
  try {
    while (s.queue.length) {
      const id = s.queue.shift()!;
      await runJob(id, s.executor ?? defaultExecutor);
    }
  } finally {
    s.running = false;
    s.resolveIdle?.();
    s.resolveIdle = null;
  }
}

/**
 * Record a queued job and schedule it. Throws ActiveJobExistsError when the
 * same catalog app already has a queued or running job for the tenant.
 */
export function enqueueMacosJob(input: NewJobInput): MacosJob {
  const job = insertJob(input);
  const s = queueState();
  s.queue.push(job.id);
  if (!s.running && !s.resolveIdle) {
    s.idle = new Promise<void>((resolve) => {
      s.resolveIdle = resolve;
    });
    setImmediate(() => {
      void drain();
    });
  }
  return job;
}
