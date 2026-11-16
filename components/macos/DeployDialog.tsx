'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2, Search, Users, X } from 'lucide-react';
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
import type { EntraIDGroup } from '@/types/intune';
import type { MacosAssignment, MacosAssignmentIntent, MacosCatalogApp } from '@/lib/macos/types';
import { readApiError } from './format';
import { useMacosApi } from './useMacosApi';

const INTENTS: { value: MacosAssignmentIntent; label: string }[] = [
  { value: 'required', label: 'Required' },
  { value: 'available', label: 'Available' },
  { value: 'uninstall', label: 'Uninstall' },
];

interface DeployDialogProps {
  app: MacosCatalogApp | null;
  onOpenChange: (open: boolean) => void;
  onQueued: () => void;
}

export function DeployDialog({ app, onOpenChange, onQueued }: DeployDialogProps) {
  const api = useMacosApi();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<EntraIDGroup[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [assignments, setAssignments] = useState<MacosAssignment[]>([]);
  const [ignoreVersionDetection, setIgnoreVersionDetection] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const searchSeq = useRef(0);

  useEffect(() => {
    if (!app) return;
    setQuery('');
    setResults([]);
    setAssignments([]);
    setIgnoreVersionDetection(false);
    setSubmitError(null);
    setSearchError(null);
  }, [app?.id]);

  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([]);
      return;
    }
    const seq = ++searchSeq.current;
    const timer = setTimeout(async () => {
      setSearching(true);
      setSearchError(null);
      try {
        const response = await api(`/api/intune/groups?search=${encodeURIComponent(query.trim())}`);
        if (!response.ok) throw new Error(await readApiError(response, 'Failed to search groups'));
        const data = (await response.json()) as { groups?: EntraIDGroup[] };
        if (seq === searchSeq.current) setResults(data.groups || []);
      } catch (error) {
        if (seq === searchSeq.current) setSearchError(error instanceof Error ? error.message : 'Failed to search groups');
      } finally {
        if (seq === searchSeq.current) setSearching(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [query, api]);

  const addGroup = (group: EntraIDGroup) => {
    if (assignments.some((a) => a.groupId === group.id)) return;
    setAssignments((current) => [...current, { groupId: group.id, groupName: group.displayName, intent: 'required' }]);
    setQuery('');
    setResults([]);
  };

  const submit = async () => {
    if (!app) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const response = await api('/api/macos/deploy', {
        method: 'POST',
        body: JSON.stringify({ catalogId: app.id, mode: 'new', assignments, ignoreVersionDetection }),
      });
      if (!response.ok) throw new Error(await readApiError(response, 'Failed to queue the deployment'));
      toast.success(`${app.name} ${app.version} queued for deployment`);
      onQueued();
      onOpenChange(false);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Failed to queue the deployment');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={app !== null} onOpenChange={(open) => !submitting && onOpenChange(open)}>
      <DialogContent className="bg-bg-surface border-overlay/10 max-w-xl">
        <DialogHeader>
          <DialogTitle>Deploy {app?.name}</DialogTitle>
          <DialogDescription>
            Creates a new macOS {app?.fileName.toLowerCase().endsWith('.pkg') ? 'PKG' : 'DMG'} app in Intune with version{' '}
            {app?.version}. The installer is checked against the catalog SHA-256 before it is committed.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium text-text-primary flex items-center gap-2 mb-2">
              <Users className="w-4 h-4" /> Assignments
            </label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search Entra ID groups..."
                className="pl-9"
              />
              {searching && <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-text-muted" />}
            </div>
            {searchError && <p className="mt-2 text-xs text-status-error">{searchError}</p>}
            {results.length > 0 && (
              <ul className="mt-2 max-h-40 overflow-y-auto rounded-lg border border-overlay/10 divide-y divide-overlay/5">
                {results.map((group) => (
                  <li key={group.id}>
                    <button
                      type="button"
                      onClick={() => addGroup(group)}
                      disabled={assignments.some((a) => a.groupId === group.id)}
                      className="w-full text-left px-3 py-2 text-sm text-text-secondary hover:bg-overlay/5 disabled:opacity-50"
                    >
                      {group.displayName}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {assignments.length === 0 ? (
              <p className="mt-3 text-xs text-text-muted">No groups yet. The app is created unassigned unless you add one.</p>
            ) : (
              <ul className="mt-3 space-y-2">
                {assignments.map((assignment) => (
                  <li
                    key={assignment.groupId}
                    className="flex items-center gap-2 rounded-lg border border-overlay/10 px-3 py-2"
                  >
                    <span className="flex-1 truncate text-sm text-text-primary">{assignment.groupName}</span>
                    <select
                      value={assignment.intent}
                      onChange={(event) =>
                        setAssignments((current) =>
                          current.map((a) =>
                            a.groupId === assignment.groupId
                              ? { ...a, intent: event.target.value as MacosAssignmentIntent }
                              : a
                          )
                        )
                      }
                      className="rounded-md border border-overlay/10 bg-bg-elevated px-2 py-1 text-xs text-text-primary"
                      aria-label={`Intent for ${assignment.groupName}`}
                    >
                      {INTENTS.map((intent) => (
                        <option key={intent.value} value={intent.value}>
                          {intent.label}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => setAssignments((current) => current.filter((a) => a.groupId !== assignment.groupId))}
                      className="text-text-muted hover:text-status-error"
                      aria-label={`Remove ${assignment.groupName}`}
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <label className="flex items-start gap-3 text-sm text-text-secondary cursor-pointer">
            <input
              type="checkbox"
              checked={ignoreVersionDetection}
              onChange={(event) => setIgnoreVersionDetection(event.target.checked)}
              className="mt-0.5"
            />
            <span>
              <span className="font-medium text-text-primary">Ignore app version</span>
              <span className="block text-xs text-text-muted">
                Install only when the app is missing, not when a different version is present. Useful for apps that update
                themselves.
              </span>
            </span>
          </label>

          {submitError && (
            <p className="rounded-lg border border-status-error/20 bg-status-error/10 px-3 py-2 text-sm text-status-error">
              {submitError}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={submitting}
            className="bg-accent-cyan hover:bg-accent-cyan-bright text-bg-deepest font-medium"
          >
            {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
            Deploy
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
