import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readLiveQaInventory, readLiveQaInventoryFromGitHub } from './github-live-qa-inventory';

const config = { token: 'test-token-never-log', owner: 'test owner', workflowsRepo: 'workflow repo',
  workflowFile: 'package-intunewin.yml', ref: 'unrelated-branch' };
const empty = { total_count: 0, workflow_runs: [] };
const response = (status = 200, text = JSON.stringify(empty)) => ({ status, text: vi.fn(async () => text) }) as unknown as Response;
const pending = <T>() => new Promise<T>(() => {});
const read = (fetchImpl: typeof fetch) => readLiveQaInventoryFromGitHub({ config, fetchImpl });

describe('fixed QA GitHub inventory HTTP adapter', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it('reads exactly the five live statuses twice using only the fixed query and GET', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => response());
    expect(await read(fetchImpl)).toEqual({ state: 'complete', inventory: empty });
    expect(fetchImpl).toHaveBeenCalledTimes(10);
    expect(fetchImpl.mock.calls.map(([input]) => new URL(String(input)).searchParams.get('status')))
      .toEqual(['queued', 'waiting', 'pending', 'requested', 'in_progress',
        'queued', 'waiting', 'pending', 'requested', 'in_progress']);
    for (const [input, init] of fetchImpl.mock.calls) {
      const url = new URL(String(input));
      expect(url.origin).toBe('https://api.github.com');
      expect(url.pathname).toBe('/repos/test%20owner/workflow%20repo/actions/workflows/intune-qa.yml/runs');
      expect([...url.searchParams.keys()]).toEqual(['status', 'per_page', 'page']);
      expect(url.searchParams.get('per_page')).toBe('100');
      expect(url.searchParams.get('page')).toBe('1');
      expect(init).toMatchObject({ method: 'GET', cache: 'no-store', redirect: 'error' });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it('collects a complete second page without adding other filters', async () => {
    const items = Array.from({ length: 101 }, (_, i) => ({ id: i + 1, status: 'queued', path: '.github/workflows/intune-qa.yml' }));
    const fetchImpl = vi.fn<typeof fetch>(async input => {
      const q = new URL(String(input)).searchParams;
      return response(200, JSON.stringify(q.get('status') === 'queued'
        ? { total_count: 101, workflow_runs: items.slice((Number(q.get('page')) - 1) * 100, Number(q.get('page')) * 100) }
        : empty));
    });
    expect(await read(fetchImpl)).toEqual({ state: 'complete', inventory: { total_count: 101, workflow_runs: items } });
    expect(fetchImpl).toHaveBeenCalledTimes(12);
  });

  it('ends a noncooperative hanging fetch after five seconds without retry', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => pending<Response>());
    const result = read(fetchImpl);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await result).toEqual({ state: 'unknown' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ends a hanging response body under the same request deadline', async () => {
    const text = vi.fn(() => pending<string>());
    const fetchImpl = vi.fn<typeof fetch>(async () => ({ status: 200, text }) as unknown as Response);
    const result = read(fetchImpl);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await result).toEqual({ state: 'unknown' });
    expect(text).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('limits the whole sequential inventory to fifteen seconds and stops new requests', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise(resolve => setTimeout(() => resolve(response()), 4_900)));
    const result = read(fetchImpl);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await result).toEqual({ state: 'unknown' });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('discards late fetch completion without reading its body', async () => {
    const late = response();
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise(resolve => setTimeout(() => resolve(late), 20_000)));
    const result = read(fetchImpl);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await result).toEqual({ state: 'unknown' });
    await vi.advanceTimersByTimeAsync(45_000);
    expect(late.text).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([304, 401, 403, 404, 429, 500])('does not read or retry HTTP %i bodies', async status => {
    const failed = response(status, config.token);
    const fetchImpl = vi.fn<typeof fetch>(async () => failed);
    expect(await read(fetchImpl)).toEqual({ state: 'unknown' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(failed.text).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['not json', ' '.repeat(4 * 1024 * 1024 + 1), JSON.stringify({ total_count: 1, workflow_runs: [] })])
    ('rejects invalid or oversized response data', async body => {
      const fetchImpl = vi.fn<typeof fetch>(async () => response(200, body));
      expect(await read(fetchImpl)).toEqual({ state: 'unknown' });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    });

  it('returns only unknown and never logs transport errors containing a token', async () => {
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'error'), vi.spyOn(console, 'warn')];
    const fetchImpl = vi.fn<typeof fetch>(async () => { throw new Error(config.token); });
    expect(await read(fetchImpl)).toEqual({ state: 'unknown' });
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it('catches missing production credentials before fetching', async () => {
    vi.stubEnv('GITHUB_PAT', '');
    const fetchImpl = vi.spyOn(globalThis, 'fetch');
    expect(await readLiveQaInventory()).toEqual({ state: 'unknown' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects empty configuration and deadline widening without requests', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => response());
    expect(await readLiveQaInventoryFromGitHub({ config: { ...config, owner: '' }, fetchImpl })).toEqual({ state: 'unknown' });
    expect(await readLiveQaInventoryFromGitHub({ config, fetchImpl, requestMs: 5_001 })).toEqual({ state: 'unknown' });
    expect(await readLiveQaInventoryFromGitHub({ config, fetchImpl, overallMs: 15_001 })).toEqual({ state: 'unknown' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
