'use client';

import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, ExternalLink, Loader2, Package, Pencil, Plus, Rocket, Search, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { MacosCatalogApp, MacosCatalogMeta, MacosCustomApp } from '@/lib/macos/types';
import { customAppToCatalogApp, isCustomAppId } from '@/lib/macos/types';
import { CustomAppDialog } from './CustomAppDialog';
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
  /** The tenant's custom apps matching the search (unpaginated). */
  customApps: MacosCustomApp[];
}

interface CatalogTabProps {
  /** Bumped by the page after a manual refresh so the list reloads. */
  reloadKey: number;
  onMeta: (meta: MacosCatalogMeta) => void;
  onDeploy: (app: MacosCatalogApp) => void;
}

function IconPlaceholder() {
  return (
    <div className="w-10 h-10 rounded-lg bg-overlay/5 flex items-center justify-center flex-shrink-0">
      <Package className="w-5 h-5 text-text-muted" />
    </div>
  );
}

interface MacosAppIconProps {
  id: string;
  name: string;
  /** Custom apps: false skips the request and shows the placeholder. */
  hasIcon?: boolean;
  /** Custom apps: changes when the app is edited, so a new icon URL is not served from cache. */
  version?: string;
}

export function MacosAppIcon({ id, name, hasIcon, version }: MacosAppIconProps) {
  const [failed, setFailed] = useState(false);
  const custom = isCustomAppId(id);
  if (failed || (custom && hasIcon === false)) return <IconPlaceholder />;
  const src = custom
    ? `/api/macos/custom-apps/${encodeURIComponent(id)}/icon${version ? `?v=${encodeURIComponent(version)}` : ''}`
    : `/api/macos/icon/${encodeURIComponent(id)}`;
  return (
    <img
      src={src}
      alt={`${name} icon`}
      loading="lazy"
      onError={() => setFailed(true)}
      className="w-10 h-10 rounded-lg object-contain flex-shrink-0"
    />
  );
}

const TAG_CLASS = 'text-[11px] px-1.5 py-0.5 rounded-md border border-overlay/10 text-text-muted';

interface AppCardProps {
  app: MacosCatalogApp;
  custom?: MacosCustomApp;
  onDeploy: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
}

function AppCard({ app, custom, onDeploy, onEdit, onDelete }: AppCardProps) {
  return (
    <div className="glass-light rounded-xl border border-overlay/5 p-4 flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <MacosAppIcon key={custom?.updatedAt} id={app.id} name={app.name} hasIcon={custom ? Boolean(custom.iconUrl) : undefined} version={custom?.updatedAt} />
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
        {custom && <span className="text-[11px] px-1.5 py-0.5 rounded-md border border-accent-cyan/30 text-accent-cyan">Custom</span>}
        {app.category && <span className={TAG_CLASS}>{app.category}</span>}
        <span className={`${TAG_CLASS} uppercase`}>{app.fileName.split('.').pop()}</span>
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
        <div className="ml-auto flex items-center gap-1">
          {onEdit && (
            <Button variant="ghost" size="sm" onClick={onEdit} aria-label={`Edit ${app.name}`} className="text-text-muted hover:text-text-primary">
              <Pencil className="w-3.5 h-3.5" />
            </Button>
          )}
          {onDelete && (
            <Button variant="ghost" size="sm" onClick={onDelete} aria-label={`Delete ${app.name}`} className="text-text-muted hover:text-status-error">
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          )}
          <Button size="sm" onClick={onDeploy} className="bg-accent-cyan hover:bg-accent-cyan-bright text-bg-deepest font-medium">
            <Rocket className="w-3.5 h-3.5" /> Deploy
          </Button>
        </div>
      </div>
    </div>
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
  const [customOnly, setCustomOnly] = useState(false);
  const [customTarget, setCustomTarget] = useState<MacosCustomApp | 'new' | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<MacosCustomApp | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [customReload, setCustomReload] = useState(0);

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
  }, [api, page, debounced, category, reloadKey, customReload]);

  useEffect(() => {
    void load();
  }, [load]);

  // While the server refreshes an empty catalog in the background, poll for it.
  useEffect(() => {
    if (!data?.meta.refreshing) return;
    const timer = setTimeout(() => void load(), 5000);
    return () => clearTimeout(timer);
  }, [data, load]);

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const response = await api(`/api/macos/custom-apps/${encodeURIComponent(deleteTarget.id)}`, { method: 'DELETE' });
      if (!response.ok) throw new Error(await readApiError(response, 'Failed to delete the custom app'));
      toast.success(`${deleteTarget.name} deleted`);
      setDeleteTarget(null);
      setCustomReload((n) => n + 1);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete the custom app');
    } finally {
      setDeleting(false);
    }
  };

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  // Custom apps are listed first, on the first page only.
  const customApps = data && (page === 1 || customOnly) ? data.customApps : [];
  const catalogApps = customOnly ? [] : (data?.apps ?? []);
  const empty = data !== null && customApps.length === 0 && catalogApps.length === 0;

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
          disabled={customOnly}
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
        <label className="flex items-center gap-2 text-sm text-text-secondary cursor-pointer whitespace-nowrap">
          <input
            type="checkbox"
            checked={customOnly}
            onChange={(event) => {
              setCustomOnly(event.target.checked);
              if (event.target.checked) setCategory('');
              setPage(1);
            }}
          />
          Custom only
        </label>
        <Button
          variant="ghost"
          onClick={() => setCustomTarget('new')}
          className="text-text-secondary hover:text-text-primary border border-overlay/10 whitespace-nowrap"
        >
          <Plus className="w-4 h-4" /> Add custom app
        </Button>
      </div>

      {error && (
        <p className="rounded-lg border border-status-error/20 bg-status-error/10 px-3 py-2 text-sm text-status-error">{error}</p>
      )}

      {loading && !data ? (
        <div className="flex items-center justify-center py-16 text-text-muted">
          <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading catalog...
        </div>
      ) : empty ? (
        <div className="py-16 text-center text-sm text-text-muted">
          {customOnly
            ? debounced
              ? 'No custom apps match your search.'
              : 'No custom apps yet. Use "Add custom app" to define one.'
            : data?.meta.refreshing
              ? 'The catalog is being downloaded from IntuneBrew. This takes a minute on first use.'
              : 'No apps match your search.'}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {customApps.map((custom) => (
            <AppCard
              key={custom.id}
              app={customAppToCatalogApp(custom)}
              custom={custom}
              onDeploy={() => onDeploy(customAppToCatalogApp(custom))}
              onEdit={() => setCustomTarget(custom)}
              onDelete={() => {
                setDeleteError(null);
                setDeleteTarget(custom);
              }}
            />
          ))}
          {catalogApps.map((app) => (
            <AppCard key={app.id} app={app} onDeploy={() => onDeploy(app)} />
          ))}
        </div>
      )}

      {!customOnly && data && data.total > data.pageSize && (
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

      <CustomAppDialog
        target={customTarget}
        onOpenChange={(open) => !open && setCustomTarget(null)}
        onSaved={() => setCustomReload((n) => n + 1)}
      />

      <Dialog open={deleteTarget !== null} onOpenChange={(open) => !open && !deleting && setDeleteTarget(null)}>
        <DialogContent className="bg-bg-surface border-overlay/10">
          <DialogHeader>
            <DialogTitle>Delete {deleteTarget?.name}</DialogTitle>
            <DialogDescription>
              Removes the custom app definition from IntuneGet. Apps already deployed to Intune are not touched, but they
              can no longer be updated from here.
            </DialogDescription>
          </DialogHeader>
          {deleteError && (
            <p className="rounded-lg border border-status-error/20 bg-status-error/10 px-3 py-2 text-sm text-status-error">
              {deleteError}
            </p>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)} disabled={deleting}>
              Cancel
            </Button>
            <Button
              onClick={() => void confirmDelete()}
              disabled={deleting}
              className="bg-status-error hover:bg-status-error/90 text-white font-medium"
            >
              {deleting && <Loader2 className="w-4 h-4 animate-spin" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
