import { describe, expect, it } from 'vitest';
import { formatDateTime, hasActiveJobs, isJobActive, readApiError } from './format';

describe('macOS dashboard helpers', () => {
  it('detects active jobs', () => {
    expect(isJobActive({ status: 'uploading' })).toBe(true);
    expect(isJobActive({ status: 'failed' })).toBe(false);
    expect(hasActiveJobs([{ status: 'completed' }, { status: 'queued' }])).toBe(true);
    expect(hasActiveJobs([{ status: 'completed' }])).toBe(false);
  });

  it('formats missing dates', () => {
    expect(formatDateTime(null)).toBe('never');
    expect(formatDateTime('not a date')).toBe('not a date');
  });

  it('reads API errors', async () => {
    expect(await readApiError(Response.json({ error: 'Nope' }, { status: 409 }), 'Failed')).toBe('Nope');
    expect(await readApiError(new Response('x', { status: 500 }), 'Failed')).toBe('Failed (500)');
  });
});
