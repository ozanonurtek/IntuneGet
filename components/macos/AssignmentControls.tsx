'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Loader2, Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import type { EntraIDGroup } from '@/types/intune';
import type { MacosAssignmentIntent } from '@/lib/macos/types';
import { MACOS_ASSIGNMENT_INTENTS } from '@/lib/macos/types';
import { readApiError } from './format';
import { useMacosApi } from './useMacosApi';

/** New assignments start as Available: Required installs on every Mac of the group. */
export const DEFAULT_ASSIGNMENT_INTENT: MacosAssignmentIntent = 'available';

const INTENT_LABELS: Record<MacosAssignmentIntent, { label: string; hint: string }> = {
  available: { label: 'Available', hint: 'Listed in Company Portal; users install it themselves' },
  required: { label: 'Required', hint: 'Installed automatically on every Mac in the group' },
  uninstall: { label: 'Uninstall', hint: 'Removed from every Mac in the group' },
};

const ACTIVE_CLASSES: Record<MacosAssignmentIntent, string> = {
  available: 'bg-accent-cyan text-bg-deepest',
  required: 'bg-status-warning text-bg-deepest',
  uninstall: 'bg-status-error text-white',
};

export function intentLabel(intent: string): string {
  return INTENT_LABELS[intent as MacosAssignmentIntent]?.label ?? intent;
}

export function isEditableIntent(intent: string): intent is MacosAssignmentIntent {
  return (MACOS_ASSIGNMENT_INTENTS as readonly string[]).includes(intent);
}

interface IntentPickerProps {
  value: string;
  onChange: (intent: MacosAssignmentIntent) => void;
  disabled?: boolean;
  label: string;
}

/** Segmented control: the chosen intent is always visible, never hidden in a dropdown. */
export function IntentPicker({ value, onChange, disabled, label }: IntentPickerProps) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-lg border border-overlay/10 p-0.5 shrink-0">
      {MACOS_ASSIGNMENT_INTENTS.map((intent) => {
        const active = value === intent;
        return (
          <button
            key={intent}
            type="button"
            role="radio"
            aria-checked={active}
            title={INTENT_LABELS[intent].hint}
            disabled={disabled}
            onClick={() => onChange(intent)}
            className={`px-2.5 py-1 text-xs rounded-md transition-colors disabled:opacity-50 ${
              active ? `${ACTIVE_CLASSES[intent]} font-medium` : 'text-text-secondary hover:bg-overlay/5'
            }`}
          >
            {INTENT_LABELS[intent].label}
          </button>
        );
      })}
    </div>
  );
}

/** Shown whenever a pending change installs or removes the app without the user's action. */
export function ForcedIntentNotice({ intents }: { intents: string[] }) {
  const required = intents.includes('required');
  const uninstall = intents.includes('uninstall');
  if (!required && !uninstall) return null;
  return (
    <p className="flex items-start gap-2 rounded-lg border border-status-warning/20 bg-status-warning/10 px-3 py-2 text-xs text-status-warning">
      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
      <span>
        {required && 'Required installs the app on every Mac in the group without asking. '}
        {uninstall && 'Uninstall removes the app from every Mac in the group. '}
        Use Available to only list it in Company Portal.
      </span>
    </p>
  );
}

interface GroupSearchProps {
  onPick: (group: EntraIDGroup) => void;
  isPicked: (groupId: string) => boolean;
}

export function GroupSearch({ onPick, isPicked }: GroupSearchProps) {
  const api = useMacosApi();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<EntraIDGroup[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seqRef = useRef(0);

  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([]);
      return;
    }
    const seq = ++seqRef.current;
    const timer = setTimeout(async () => {
      setSearching(true);
      setError(null);
      try {
        const response = await api(`/api/intune/groups?search=${encodeURIComponent(query.trim())}`);
        if (!response.ok) throw new Error(await readApiError(response, 'Failed to search groups'));
        const data = (await response.json()) as { groups?: EntraIDGroup[] };
        if (seq === seqRef.current) setResults(data.groups || []);
      } catch (err) {
        if (seq === seqRef.current) setError(err instanceof Error ? err.message : 'Failed to search groups');
      } finally {
        if (seq === seqRef.current) setSearching(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [query, api]);

  return (
    <div>
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
      {error && <p className="mt-2 text-xs text-status-error">{error}</p>}
      {results.length > 0 && (
        <ul className="mt-2 max-h-40 overflow-y-auto rounded-lg border border-overlay/10 divide-y divide-overlay/5">
          {results.map((group) => (
            <li key={group.id}>
              <button
                type="button"
                onClick={() => {
                  onPick(group);
                  setQuery('');
                  setResults([]);
                }}
                disabled={isPicked(group.id)}
                className="w-full text-left px-3 py-2 text-sm text-text-secondary hover:bg-overlay/5 disabled:opacity-50"
              >
                {group.displayName}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
