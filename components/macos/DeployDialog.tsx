'use client';

import { useEffect, useState } from 'react';
import { Loader2, Users, X } from 'lucide-react';
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
import type { EntraIDGroup } from '@/types/intune';
import type { MacosAssignment, MacosCatalogApp } from '@/lib/macos/types';
import { isCustomAppId } from '@/lib/macos/types';
import { readApiError } from './format';
import { DEFAULT_ASSIGNMENT_INTENT, ForcedIntentNotice, GroupSearch, IntentPicker } from './AssignmentControls';
import { useMacosApi } from './useMacosApi';

interface DeployDialogProps {
  app: MacosCatalogApp | null;
  onOpenChange: (open: boolean) => void;
  onQueued: () => void;
}

export function DeployDialog({ app, onOpenChange, onQueued }: DeployDialogProps) {
  const api = useMacosApi();
  const [assignments, setAssignments] = useState<MacosAssignment[]>([]);
  const [ignoreVersionDetection, setIgnoreVersionDetection] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (!app) return;
    setAssignments([]);
    setIgnoreVersionDetection(false);
    setSubmitError(null);
  }, [app?.id]);

  const addGroup = (group: EntraIDGroup) => {
    if (assignments.some((a) => a.groupId === group.id)) return;
    setAssignments((current) => [
      ...current,
      { groupId: group.id, groupName: group.displayName, intent: DEFAULT_ASSIGNMENT_INTENT },
    ]);
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
            {app?.version}. The installer is checked against the {app && isCustomAppId(app.id) ? 'saved' : 'catalog'} SHA-256 before it is committed.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium text-text-primary flex items-center gap-2 mb-2">
              <Users className="w-4 h-4" /> Assignments
            </label>
            <GroupSearch onPick={addGroup} isPicked={(id) => assignments.some((a) => a.groupId === id)} />
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
                    <IntentPicker
                      label={`Intent for ${assignment.groupName}`}
                      value={assignment.intent}
                      onChange={(intent) =>
                        setAssignments((current) =>
                          current.map((a) => (a.groupId === assignment.groupId ? { ...a, intent } : a))
                        )
                      }
                    />
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

          <ForcedIntentNotice intents={assignments.map((a) => a.intent)} />

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
