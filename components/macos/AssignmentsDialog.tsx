'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Undo2, Users, X } from 'lucide-react';
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
import type { MacosAppAssignment, MacosAssignment, MacosAssignmentIntent, MacosTenantApp } from '@/lib/macos/types';
import {
  DEFAULT_ASSIGNMENT_INTENT,
  ForcedIntentNotice,
  GroupSearch,
  IntentPicker,
  intentLabel,
  isEditableIntent,
} from './AssignmentControls';
import { readApiError } from './format';
import { useMacosApi } from './useMacosApi';

const TARGET_LABELS: Record<MacosAppAssignment['targetKind'], string> = {
  group: '',
  excludedGroup: 'Excluded',
  allUsers: 'All users',
  allDevices: 'All devices',
  other: 'Other target',
};

function targetName(a: MacosAppAssignment): string {
  if (a.targetKind === 'group' || a.targetKind === 'excludedGroup') return a.groupName || a.groupId || 'Unknown group';
  return TARGET_LABELS[a.targetKind];
}

interface AssignmentsDialogProps {
  app: MacosTenantApp | null;
  onOpenChange: (open: boolean) => void;
}

/**
 * Edit an existing Intune app's assignments. Changes are staged and applied on
 * Save, one Graph call each: removals, intent changes, then new groups.
 */
export function AssignmentsDialog({ app, onOpenChange }: AssignmentsDialogProps) {
  const api = useMacosApi();
  const [current, setCurrent] = useState<MacosAppAssignment[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [intentChanges, setIntentChanges] = useState<Record<string, MacosAssignmentIntent>>({});
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [added, setAdded] = useState<MacosAssignment[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveErrors, setSaveErrors] = useState<string[]>([]);

  const base = app ? `/api/macos/tenant-apps/${encodeURIComponent(app.intuneAppId)}/assignments` : '';

  const reset = () => {
    setIntentChanges({});
    setRemoved(new Set());
    setAdded([]);
  };

  const load = useCallback(async () => {
    if (!base) return;
    setLoading(true);
    setLoadError(null);
    try {
      const response = await api(base);
      if (!response.ok) throw new Error(await readApiError(response, 'Failed to read the assignments'));
      setCurrent(((await response.json()) as { assignments: MacosAppAssignment[] }).assignments);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to read the assignments');
    } finally {
      setLoading(false);
    }
  }, [api, base]);

  useEffect(() => {
    setCurrent(null);
    setSaveErrors([]);
    reset();
    if (app) void load();
  }, [app?.intuneAppId, load]);

  const assignedGroupIds = useMemo(() => {
    const ids = new Set<string>();
    for (const a of current || []) if (a.groupId && !removed.has(a.id)) ids.add(a.groupId.toLowerCase());
    for (const a of added) ids.add(a.groupId.toLowerCase());
    return ids;
  }, [current, removed, added]);

  const dirty = Object.keys(intentChanges).length > 0 || removed.size > 0 || added.length > 0;
  const pendingIntents = [...Object.values(intentChanges), ...added.map((a) => a.intent)];

  const addGroup = (group: EntraIDGroup) => {
    if (assignedGroupIds.has(group.id.toLowerCase())) return;
    setAdded((list) => [...list, { groupId: group.id, groupName: group.displayName, intent: DEFAULT_ASSIGNMENT_INTENT }]);
  };

  const setIntent = (a: MacosAppAssignment, intent: MacosAssignmentIntent) =>
    setIntentChanges((changes) => {
      const next = { ...changes };
      if (intent === a.intent) delete next[a.id];
      else next[a.id] = intent;
      return next;
    });

  const toggleRemoved = (id: string) =>
    setRemoved((set) => {
      const next = new Set(set);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const save = async () => {
    if (!app || !current) return;
    setSaving(true);
    setSaveErrors([]);
    const errors: string[] = [];
    const run = async (what: string, path: string, init: RequestInit) => {
      try {
        const response = await api(path, init);
        if (!response.ok) throw new Error(await readApiError(response, `${what} failed`));
      } catch (err) {
        errors.push(`${what}: ${err instanceof Error ? err.message : 'failed'}`);
      }
    };
    for (const a of current) {
      if (removed.has(a.id)) {
        await run(`Remove ${targetName(a)}`, `${base}/${encodeURIComponent(a.id)}`, { method: 'DELETE' });
      } else if (intentChanges[a.id]) {
        await run(`${targetName(a)} -> ${intentLabel(intentChanges[a.id])}`, `${base}/${encodeURIComponent(a.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ intent: intentChanges[a.id] }),
        });
      }
    }
    for (const a of added) {
      await run(`Add ${a.groupName}`, base, { method: 'POST', body: JSON.stringify(a) });
    }
    setSaving(false);
    reset();
    await load();
    if (errors.length) {
      setSaveErrors(errors);
    } else {
      toast.success(`Assignments of ${app.displayName} saved`);
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={app !== null} onOpenChange={(open) => !saving && onOpenChange(open)}>
      <DialogContent className="bg-bg-surface border-overlay/10 max-w-2xl">
        <DialogHeader>
          <DialogTitle>Assignments: {app?.displayName}</DialogTitle>
          <DialogDescription>
            Who gets this app in Intune. Available lists it in Company Portal, Required installs it on every Mac in the
            group, Uninstall removes it. Changes apply when you save; Macs pick them up at their next check-in.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {loadError && (
            <p className="rounded-lg border border-status-error/20 bg-status-error/10 px-3 py-2 text-sm text-status-error">
              {loadError}
            </p>
          )}

          {loading && !current ? (
            <div className="flex items-center justify-center py-8 text-text-muted">
              <Loader2 className="w-5 h-5 animate-spin mr-2" /> Reading Intune...
            </div>
          ) : (
            current && (
              <ul className="space-y-2">
                {current.length === 0 && added.length === 0 && (
                  <li className="text-xs text-text-muted">Not assigned to anyone yet.</li>
                )}
                {current.map((a) => {
                  const isRemoved = removed.has(a.id);
                  const intent = intentChanges[a.id] ?? a.intent;
                  const tag = TARGET_LABELS[a.targetKind];
                  return (
                    <li
                      key={a.id}
                      className={`flex items-center gap-2 rounded-lg border border-overlay/10 px-3 py-2 ${isRemoved ? 'opacity-50' : ''}`}
                    >
                      <span className={`flex-1 min-w-0 truncate text-sm text-text-primary ${isRemoved ? 'line-through' : ''}`}>
                        {targetName(a)}
                        {tag && a.targetKind !== 'allUsers' && a.targetKind !== 'allDevices' && (
                          <span className="ml-2 text-[11px] text-text-muted">{tag}</span>
                        )}
                        {a.hasFilter && <span className="ml-2 text-[11px] text-text-muted">filter</span>}
                        {intentChanges[a.id] && !isRemoved && (
                          <span className="ml-2 text-[11px] text-text-muted">was {intentLabel(a.intent)}</span>
                        )}
                      </span>
                      {isEditableIntent(a.intent) ? (
                        <IntentPicker
                          label={`Intent for ${targetName(a)}`}
                          value={intent}
                          disabled={isRemoved || saving}
                          onChange={(next) => setIntent(a, next)}
                        />
                      ) : (
                        <span className="text-xs text-text-muted">{a.intent}</span>
                      )}
                      <button
                        type="button"
                        onClick={() => toggleRemoved(a.id)}
                        disabled={saving}
                        className="text-text-muted hover:text-status-error"
                        aria-label={isRemoved ? `Keep ${targetName(a)}` : `Remove ${targetName(a)}`}
                        title={isRemoved ? 'Keep' : 'Remove'}
                      >
                        {isRemoved ? <Undo2 className="w-4 h-4" /> : <X className="w-4 h-4" />}
                      </button>
                    </li>
                  );
                })}
                {added.map((a) => (
                  <li key={a.groupId} className="flex items-center gap-2 rounded-lg border border-accent-cyan/30 px-3 py-2">
                    <span className="flex-1 min-w-0 truncate text-sm text-text-primary">
                      {a.groupName}
                      <span className="ml-2 text-[11px] text-accent-cyan">new</span>
                    </span>
                    <IntentPicker
                      label={`Intent for ${a.groupName}`}
                      value={a.intent}
                      disabled={saving}
                      onChange={(intent) =>
                        setAdded((list) => list.map((x) => (x.groupId === a.groupId ? { ...x, intent } : x)))
                      }
                    />
                    <button
                      type="button"
                      onClick={() => setAdded((list) => list.filter((x) => x.groupId !== a.groupId))}
                      disabled={saving}
                      className="text-text-muted hover:text-status-error"
                      aria-label={`Remove ${a.groupName}`}
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </li>
                ))}
              </ul>
            )
          )}

          {current && (
            <div>
              <label className="text-sm font-medium text-text-primary flex items-center gap-2 mb-2">
                <Users className="w-4 h-4" /> Add a group
              </label>
              <GroupSearch onPick={addGroup} isPicked={(id) => assignedGroupIds.has(id.toLowerCase())} />
            </div>
          )}

          <ForcedIntentNotice intents={pendingIntents} />

          {saveErrors.length > 0 && (
            <div className="rounded-lg border border-status-error/20 bg-status-error/10 px-3 py-2 text-sm text-status-error space-y-1">
              <p>Some changes were not applied (the list above shows what Intune has now):</p>
              {saveErrors.map((e) => (
                <p key={e} className="text-xs">{e}</p>
              ))}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            {dirty ? 'Cancel' : 'Close'}
          </Button>
          <Button
            onClick={() => void save()}
            disabled={!dirty || saving || !current}
            className="bg-accent-cyan hover:bg-accent-cyan-bright text-bg-deepest font-medium"
          >
            {saving && <Loader2 className="w-4 h-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
