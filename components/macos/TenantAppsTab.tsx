'use client';

import { useCallback, useEffect, useState } from 'react';
import { ArrowUpCircle, CheckCircle2, Loader2, RefreshCw, Users } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { StatusBadge } from '@/components/ui/status-badge';
import type { MacosTenantApp } from '@/lib/macos/types';
import { AssignmentsDialog } from './AssignmentsDialog';
import { MacosAppIcon } from './CatalogTab';
import { readApiError } from './format';
import { useMacosApi } from './useMacosApi';

const TYPE_LABELS: Record<MacosTenantApp['appType'], string> = {
  macOSPkgApp: 'PKG',
  macOSDmgApp: 'DMG',
  macOSLobApp: 'LOB',
};

interface TenantAppsTabProps {
  onQueued: () => void;
}

export function TenantAppsTab({ onQueued }: TenantAppsTabProps) {
  const api = useMacosApi();
  const [apps, setApps] = useState<MacosTenantApp[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<MacosTenantApp | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [assigning, setAssigning] = useState<MacosTenantApp | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api('/api/macos/tenant-apps');
      if (!response.ok) throw new Error(await readApiError(response, "Failed to load the tenant's macOS apps"));
      setApps(((await response.json()) as { apps: MacosTenantApp[] }).apps);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load the tenant's macOS apps");
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const confirmUpdate = async () => {
    if (!pending?.catalogId) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const response = await api('/api/macos/deploy', {
        method: 'POST',
        body: JSON.stringify({ catalogId: pending.catalogId, mode: 'update', intuneAppId: pending.intuneAppId }),
      });
      if (!response.ok) throw new Error(await readApiError(response, 'Failed to queue the update'));
      toast.success(`Update of ${pending.displayName} to ${pending.catalogVersion} queued`);
      setPending(null);
      onQueued();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to queue the update');
    } finally {
      setSubmitting(false);
    }
  };

  const updates = apps?.filter((a) => a.updateAvailable && a.updateSupported).length ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-text-secondary">
          {apps ? `${apps.length} macOS app(s) in Intune, ${updates} with a newer catalog version.` : ' '}
        </p>
        <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading} className="text-text-secondary">
          <RefreshCw className={loading ? 'w-4 h-4 animate-spin' : 'w-4 h-4'} /> Reload
        </Button>
      </div>

      {error && (
        <p className="rounded-lg border border-status-error/20 bg-status-error/10 px-3 py-2 text-sm text-status-error">{error}</p>
      )}

      {loading && !apps ? (
        <div className="flex items-center justify-center py-16 text-text-muted">
          <Loader2 className="w-5 h-5 animate-spin mr-2" /> Reading Intune...
        </div>
      ) : apps && apps.length === 0 ? (
        <div className="py-16 text-center text-sm text-text-muted">No macOS PKG, DMG or LOB apps in Intune yet.</div>
      ) : (
        apps && (
          <div className="glass-light rounded-xl border border-overlay/5 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-text-muted border-b border-overlay/5">
                  <th className="px-4 py-3 font-medium">App</th>
                  <th className="px-4 py-3 font-medium">Type</th>
                  <th className="px-4 py-3 font-medium">In Intune</th>
                  <th className="px-4 py-3 font-medium">Catalog</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-overlay/5">
                {apps.map((app) => (
                  <tr key={app.intuneAppId}>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        {app.catalogId ? <MacosAppIcon id={app.catalogId} name={app.displayName} /> : <div className="w-10 h-10" />}
                        <div className="min-w-0">
                          <p className="font-medium text-text-primary truncate">{app.displayName}</p>
                          <p className="text-xs text-text-muted font-mono truncate">{app.bundleId || 'no bundle ID'}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-text-secondary">{TYPE_LABELS[app.appType]}</td>
                    <td className="px-4 py-3 font-mono text-text-secondary">{app.installedVersion || '-'}</td>
                    <td className="px-4 py-3 font-mono text-text-secondary">
                      {app.catalogVersion || '-'}
                      {app.catalogCustom && (
                        <span className="ml-2 font-sans text-[11px] px-1.5 py-0.5 rounded-md border border-accent-cyan/30 text-accent-cyan">
                          Custom
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {!app.catalogId ? (
                        <StatusBadge tone="muted">Not in catalog</StatusBadge>
                      ) : app.updateAvailable ? (
                        <StatusBadge tone="warning" icon={ArrowUpCircle}>
                          Update available
                        </StatusBadge>
                      ) : (
                        <StatusBadge tone="success" icon={CheckCircle2}>
                          Up to date
                        </StatusBadge>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap space-x-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setAssigning(app)}
                        className="text-text-secondary"
                        aria-label={`Assignments of ${app.displayName}`}
                      >
                        <Users className="w-4 h-4" /> Assignments
                      </Button>
                      {app.updateAvailable && app.updateSupported && (
                        <Button
                          size="sm"
                          onClick={() => {
                            setSubmitError(null);
                            setPending(app);
                          }}
                          className="bg-accent-cyan hover:bg-accent-cyan-bright text-bg-deepest font-medium"
                        >
                          Update
                        </Button>
                      )}
                      {app.updateAvailable && !app.updateSupported && (
                        <span className="text-xs text-text-muted">LOB apps cannot be updated here</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      <AssignmentsDialog app={assigning} onOpenChange={(open) => !open && setAssigning(null)} />

      <Dialog open={pending !== null} onOpenChange={(open) => !open && !submitting && setPending(null)}>
        <DialogContent className="bg-bg-surface border-overlay/10">
          <DialogHeader>
            <DialogTitle>Update {pending?.displayName}</DialogTitle>
            <DialogDescription>
              Uploads version {pending?.catalogVersion} as a new content version of the existing Intune app (currently{' '}
              {pending?.installedVersion || 'unknown'}). The app keeps its name, settings and assignments; assigned Macs
              receive the new version at their next check-in.
            </DialogDescription>
          </DialogHeader>
          {submitError && (
            <p className="rounded-lg border border-status-error/20 bg-status-error/10 px-3 py-2 text-sm text-status-error">
              {submitError}
            </p>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPending(null)} disabled={submitting}>
              Cancel
            </Button>
            <Button
              onClick={() => void confirmUpdate()}
              disabled={submitting}
              className="bg-accent-cyan hover:bg-accent-cyan-bright text-bg-deepest font-medium"
            >
              {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
              Update
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
