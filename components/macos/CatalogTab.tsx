'use client';

import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, ExternalLink, Loader2, Package, Rocket, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { MacosCatalogApp, MacosCatalogMeta } from '@/lib/macos/types';
import { readApiError } from './format';
import { useMacosApi } from './useMacosApi';

const PAGE_SIZE = 48;

interface CatalogResponse {
  apps: MacosCatalogApp[];
  total: number;
  page: number;
  pageSize: number;
  categories: string[];
  meta: MacosCatalogMeta;
}

interface CatalogTabProps {
  /** Bumped by the page after a manual refresh so the list reloads. */
  reloadKey: number;
  onMeta: (meta: MacosCatalogMeta) => void;
  onDeploy: (app: MacosCatalogApp) => void;
}

export function MacosAppIcon({ id, name }: { id: string; name: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div className="w-10 h-10 rounded-lg bg-overlay/5 flex items-center justify-center flex-shrink-0">
        <Package className="w-5 h-5 text-text-muted" />
      </div>
    );
  }
  return (
    <img
      src={`/api/macos/icon/${encodeURIComponent(id)}`}
      alt={`${name} icon`}
      loading="lazy"
      onError={() => setFailed(true)}
      className="w-10 h-10 rounded-lg object-contain flex-shrink-0"
    />
  );
}

export function CatalogTab({ reloadKey, onMeta, onDeploy }: CatalogTabProps) {
  const api = useMacosApi();
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [category, setCategory] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<CatalogResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(search.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (debounced) params.set('search', debounced);
      if (category) params.set('category', category);
      const response = await api(`/api/macos/catalog?${params}`);
      if (!response.ok) throw new Error(await readApiError(response, 'Failed to load the macOS catalog'));
      const body = (await response.json()) as CatalogResponse;
      setData(body);
      onMeta(body.meta);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load the macOS catalog');
    } finally {
      setLoading(false);
    }
  }, [api, page, debounced, category, reloadKey]);

  useEffect(() => {
    void load();
  }, [load]);

  // While the server refreshes an empty catalog in the background, poll for it.
  useEffect(() => {
    if (!data?.meta.refreshing) return;
    const timer = setTimeout(() => void load(), 5000);
    return () => clearTimeout(timer);
  }, [data, load]);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by name, publisher or bundle ID..."
            className="pl-9"
          />
        </div>
        <select
          value={category}
          onChange={(event) => {
            setCategory(event.target.value);
            setPage(1);
          }}
          className="rounded-md border border-overlay/10 bg-bg-elevated px-3 py-2 text-sm text-text-primary"
          aria-label="Category"
        >
          <option value="">All categories</option>
          {data?.categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <p className="rounded-lg border border-status-error/20 bg-status-error/10 px-3 py-2 text-sm text-status-error">{error}</p>
      )}

      {loading && !data ? (
        <div className="flex items-center justify-center py-16 text-text-muted">
          <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading catalog...
        </div>
      ) : data && data.apps.length === 0 ? (
        <div className="py-16 text-center text-sm text-text-muted">
          {data.meta.refreshing
            ? 'The catalog is being downloaded from IntuneBrew. This takes a minute on first use.'
            : 'No apps match your search.'}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {data?.apps.map((app) => (
            <div key={app.id} className="glass-light rounded-xl border border-overlay/5 p-4 flex flex-col gap-3">
              <div className="flex items-start gap-3">
                <MacosAppIcon id={app.id} name={app.name} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-text-primary truncate">{app.name}</p>
                  <p className="text-xs text-text-muted truncate">{app.publisher || app.bundleId}</p>
                </div>
                <span className="px-2 py-0.5 text-xs font-mono bg-overlay/[0.04] text-text-secondary border border-overlay/10 rounded-md flex-shrink-0">
                  {app.version}
                </span>
              </div>
              {app.description && <p className="text-xs text-text-secondary line-clamp-2">{app.description}</p>}
              <div className="mt-auto flex items-center gap-2">
                {app.category && (
                  <span className="text-[11px] px-1.5 py-0.5 rounded-md border border-overlay/10 text-text-muted">{app.category}</span>
                )}
                <span className="text-[11px] px-1.5 py-0.5 rounded-md border border-overlay/10 text-text-muted uppercase">
                  {app.fileName.split('.').pop()}
                </span>
                {app.homepage && (
                  <a
                    href={app.homepage}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-text-muted hover:text-text-primary"
                    aria-label={`${app.name} homepage`}
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                )}
                <Button
                  size="sm"
                  onClick={() => onDeploy(app)}
                  className="ml-auto bg-accent-cyan hover:bg-accent-cyan-bright text-bg-deepest font-medium"
                >
                  <Rocket className="w-3.5 h-3.5" /> Deploy
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {data && data.total > data.pageSize && (
        <div className="flex items-center justify-between text-sm text-text-secondary">
          <span>
            {data.total} apps, page {data.page} of {totalPages}
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" disabled={page <= 1 || loading} onClick={() => setPage((p) => p - 1)}>
              <ChevronLeft className="w-4 h-4" /> Previous
            </Button>
            <Button variant="ghost" size="sm" disabled={page >= totalPages || loading} onClick={() => setPage((p) => p + 1)}>
              Next <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
