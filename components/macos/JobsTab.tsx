'use client';

import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Clock, Loader2, RefreshCw, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { StatusBadge, type StatusTone } from '@/components/ui/status-badge';
import type { MacosJob } from '@/lib/macos/types';
import { JOB_STATUS_LABELS, formatDateTime, hasActiveJobs, isJobActive, readApiError } from './format';
import { useMacosApi } from './useMacosApi';

const POLL_MS = 5000;

interface JobsTabProps {
  /** Bumped by the page when a job was queued so the list reloads at once. */
  reloadKey: number;
}

function tone(job: MacosJob): StatusTone {
  if (job.status === 'completed') return job.errorMessage ? 'warning' : 'success';
  if (job.status === 'failed') return 'error';
  return job.status === 'queued' ? 'neutral' : 'accent';
}

export function JobsTab({ reloadKey }: JobsTabProps) {
  const api = useMacosApi();
  const [jobs, setJobs] = useState<MacosJob[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await api('/api/macos/jobs');
      if (!response.ok) throw new Error(await readApiError(response, 'Failed to load jobs'));
      setJobs(((await response.json()) as { jobs: MacosJob[] }).jobs);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load jobs');
    } finally {
      setLoading(false);
    }
  }, [api, reloadKey]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!jobs || !hasActiveJobs(jobs)) return;
    const timer = setTimeout(() => void load(), POLL_MS);
    return () => clearTimeout(timer);
  }, [jobs, load]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-text-secondary">
          Deployments run one at a time. Progress refreshes every 5 seconds while a job is active.
        </p>
        <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading} className="text-text-secondary">
          <RefreshCw className={loading ? 'w-4 h-4 animate-spin' : 'w-4 h-4'} /> Reload
        </Button>
      </div>

      {error && (
        <p className="rounded-lg border border-status-error/20 bg-status-error/10 px-3 py-2 text-sm text-status-error">{error}</p>
      )}

      {loading && !jobs ? (
        <div className="flex items-center justify-center py-16 text-text-muted">
          <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading jobs...
        </div>
      ) : jobs && jobs.length === 0 ? (
        <div className="py-16 text-center text-sm text-text-muted">No macOS deployments yet.</div>
      ) : (
        <div className="space-y-3">
          {jobs?.map((job) => (
            <div key={job.id} className="glass-light rounded-xl border border-overlay/5 p-4 space-y-2">
              <div className="flex flex-wrap items-center gap-3">
                <p className="text-sm font-semibold text-text-primary">
                  {job.appName} <span className="font-mono font-normal text-text-secondary">{job.version}</span>
                </p>
                <span className="text-[11px] px-1.5 py-0.5 rounded-md border border-overlay/10 text-text-muted uppercase">
                  {job.mode === 'new' ? 'New app' : 'Update'}
                </span>
                <StatusBadge
                  tone={tone(job)}
                  icon={job.status === 'completed' ? CheckCircle2 : job.status === 'failed' ? XCircle : job.status === 'queued' ? Clock : Loader2}
                  iconClassName={isJobActive(job) && job.status !== 'queued' ? 'animate-spin' : undefined}
                >
                  {JOB_STATUS_LABELS[job.status]}
                  {isJobActive(job) && job.status !== 'queued' ? ` ${job.progressPercent}%` : ''}
                </StatusBadge>
                <span className="ml-auto text-xs text-text-muted">
                  {formatDateTime(job.createdAt)}
                  {job.userEmail ? ` by ${job.userEmail}` : ''}
                </span>
              </div>
              {isJobActive(job) && (
                <div className="w-full h-1.5 bg-overlay/10 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-accent-cyan rounded-full transition-all duration-300"
                    style={{ width: `${job.progressPercent}%` }}
                  />
                </div>
              )}
              {job.assignments.length > 0 && (
                <p className="text-xs text-text-muted">
                  Assignments: {job.assignments.map((a) => `${a.groupName || a.groupId} (${a.intent})`).join(', ')}
                </p>
              )}
              {job.errorMessage && (
                <p className={job.status === 'failed' ? 'text-xs text-status-error' : 'text-xs text-status-warning'}>
                  {job.errorMessage}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
