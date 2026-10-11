import { getGitHubActionsConfig, type GitHubActionsConfig } from '../github-actions';
import { readStableLiveQaInventory, type ReadQaRunPage } from './live-workflow-inventory';

type Dependencies = {
  config: Pick<GitHubActionsConfig, 'token' | 'owner' | 'workflowsRepo'>;
  fetchImpl: typeof fetch;
  requestMs?: number;
  overallMs?: number;
};

const UNKNOWN = { state: 'unknown' } as const;
const STATUSES = new Set(['queued', 'waiting', 'pending', 'requested', 'in_progress']);
const MAX_BODY_CHARACTERS = 4 * 1024 * 1024;

function deadlineError() { return new Error('QA inventory unavailable'); }

/** Race even transports or response bodies that do not cooperate with abort. */
async function withinDeadline<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw deadlineError();
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(deadlineError());
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const value = await Promise.race([operation, aborted]);
    if (signal.aborted) throw deadlineError();
    return value;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** Private, read-only adapter. No route imports it until the dispatch guard is reviewed. */
export async function readLiveQaInventoryFromGitHub(deps: Dependencies) {
  const overall = new AbortController();
  const requestMs = deps.requestMs ?? 5_000;
  const overallMs = deps.overallMs ?? 15_000;
  let overallTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { token, owner, workflowsRepo } = deps.config;
    if (!token || !owner || !workflowsRepo ||
        !Number.isFinite(requestMs) || requestMs <= 0 || requestMs > 5_000 ||
        !Number.isFinite(overallMs) || overallMs <= 0 || overallMs > 15_000) return UNKNOWN;
    overallTimer = setTimeout(() => overall.abort(), overallMs);
    const readPage: ReadQaRunPage = async query => {
      if (overall.signal.aborted || query.workflow !== 'intune-qa.yml' ||
          !STATUSES.has(query.status) || query.per_page !== 100 ||
          (query.page !== 1 && query.page !== 2)) throw deadlineError();
      const request = new AbortController();
      const onOverallAbort = () => request.abort();
      overall.signal.addEventListener('abort', onOverallAbort, { once: true });
      const timer = setTimeout(() => request.abort(), requestMs);
      try {
        const params = new URLSearchParams({ status: query.status, per_page: '100', page: String(query.page) });
        const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(workflowsRepo)}/actions/workflows/intune-qa.yml/runs?${params}`;
        const response = await withinDeadline(deps.fetchImpl(url, {
          method: 'GET', cache: 'no-store', redirect: 'error', signal: request.signal,
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28' },
        }), request.signal);
        if (overall.signal.aborted || request.signal.aborted || response.status !== 200) throw deadlineError();
        const body = await withinDeadline(response.text(), request.signal);
        if (overall.signal.aborted || request.signal.aborted || body.length > MAX_BODY_CHARACTERS) throw deadlineError();
        return JSON.parse(body) as unknown;
      } finally {
        clearTimeout(timer);
        overall.signal.removeEventListener('abort', onOverallAbort);
      }
    };
    return await withinDeadline(readStableLiveQaInventory(readPage), overall.signal);
  } catch {
    return UNKNOWN;
  } finally {
    if (overallTimer !== undefined) clearTimeout(overallTimer);
    overall.abort();
  }
}

/** Configuration exceptions and all transport failures remain unknown, without logs. */
export async function readLiveQaInventory() {
  try {
    return await readLiveQaInventoryFromGitHub({ config: getGitHubActionsConfig(), fetchImpl: fetch });
  } catch {
    return UNKNOWN;
  }
}
