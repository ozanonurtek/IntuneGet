'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
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
import type { MacosCustomApp } from '@/lib/macos/types';
import { readApiError } from './format';
import { useMacosApi } from './useMacosApi';

interface FormState {
  name: string;
  publisher: string;
  version: string;
  bundleId: string;
  url: string;
  sha256: string;
  description: string;
  homepage: string;
  iconUrl: string;
}

const EMPTY: FormState = {
  name: '',
  publisher: '',
  version: '',
  bundleId: '',
  url: '',
  sha256: '',
  description: '',
  homepage: '',
  iconUrl: '',
};

function fromApp(app: MacosCustomApp): FormState {
  return {
    name: app.name,
    publisher: app.publisher,
    version: app.version,
    bundleId: app.bundleId,
    url: app.url,
    sha256: app.sha256,
    description: app.description ?? '',
    homepage: app.homepage ?? '',
    iconUrl: app.iconUrl ?? '',
  };
}

interface CustomAppDialogProps {
  /** null: closed; 'new': add; an app: edit it. */
  target: MacosCustomApp | 'new' | null;
  onOpenChange: (open: boolean) => void;
  onSaved: (app: MacosCustomApp) => void;
}

const FIELDS: {
  key: keyof FormState;
  label: string;
  placeholder: string;
  required?: boolean;
  mono?: boolean;
  help?: ReactNode;
}[] = [
  { key: 'name', label: 'Name', placeholder: 'Acme Agent', required: true },
  { key: 'publisher', label: 'Publisher', placeholder: 'Acme Corp', required: true },
  { key: 'version', label: 'Version', placeholder: '1.2.3', required: true, mono: true },
  {
    key: 'bundleId',
    label: 'Bundle ID',
    placeholder: 'com.acme.agent',
    required: true,
    mono: true,
    help: (
      <>
        Find the bundle ID on a Mac with <code className="font-mono">osascript -e &apos;id of app &quot;AppName&quot;&apos;</code>
      </>
    ),
  },
  {
    key: 'url',
    label: 'Installer URL',
    placeholder: 'https://downloads.example.com/AcmeAgent-1.2.3.pkg',
    required: true,
    mono: true,
    help: 'An https link to the .pkg or .dmg file.',
  },
  {
    key: 'sha256',
    label: 'SHA-256',
    placeholder: '64 hexadecimal characters',
    required: true,
    mono: true,
    help: (
      <>
        SHA-256: <code className="font-mono">shasum -a 256 &lt;file&gt;</code>
      </>
    ),
  },
  { key: 'description', label: 'Description', placeholder: 'Optional' },
  { key: 'homepage', label: 'Homepage', placeholder: 'Optional, https://...' },
  { key: 'iconUrl', label: 'Icon URL', placeholder: 'Optional, https link to a PNG', help: 'Used as the Intune app icon.' },
];

export function CustomAppDialog({ target, onOpenChange, onSaved }: CustomAppDialogProps) {
  const api = useMacosApi();
  const [form, setForm] = useState<FormState>(EMPTY);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const editing = target !== null && target !== 'new' ? target : null;

  useEffect(() => {
    if (target === null) return;
    setForm(target === 'new' ? EMPTY : fromApp(target));
    setFieldErrors({});
    setSubmitError(null);
  }, [target]);

  const submit = async () => {
    setSubmitting(true);
    setSubmitError(null);
    setFieldErrors({});
    try {
      const response = await api(editing ? `/api/macos/custom-apps/${encodeURIComponent(editing.id)}` : '/api/macos/custom-apps', {
        method: editing ? 'PUT' : 'POST',
        body: JSON.stringify(form),
      });
      if (!response.ok) {
        const body = (await response.clone().json().catch(() => null)) as { fields?: Record<string, string> } | null;
        if (body?.fields) setFieldErrors(body.fields);
        throw new Error(await readApiError(response, 'Failed to save the custom app'));
      }
      const { app } = (await response.json()) as { app: MacosCustomApp };
      toast.success(editing ? `${app.name} updated` : `${app.name} added`);
      onSaved(app);
      onOpenChange(false);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Failed to save the custom app');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={target !== null} onOpenChange={(open) => !submitting && onOpenChange(open)}>
      <DialogContent className="bg-bg-surface border-overlay/10 max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit ${editing.name}` : 'Add custom app'}</DialogTitle>
          <DialogDescription>
            A macOS PKG or DMG installer that is not in the IntuneBrew catalog. To ship a new version, edit the app and
            change its version, installer URL and SHA-256, then update it from the &quot;Our Macs&apos; apps&quot; tab.
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {FIELDS.map((field) => (
            <div key={field.key}>
              <label htmlFor={`custom-app-${field.key}`} className="text-sm font-medium text-text-primary">
                {field.label}
                {field.required && <span className="text-status-error"> *</span>}
              </label>
              <Input
                id={`custom-app-${field.key}`}
                value={form[field.key]}
                onChange={(event) => setForm((current) => ({ ...current, [field.key]: event.target.value }))}
                placeholder={field.placeholder}
                required={field.required}
                className={field.mono ? 'mt-1 font-mono text-xs' : 'mt-1'}
              />
              {fieldErrors[field.key] ? (
                <p className="mt-1 text-xs text-status-error">{fieldErrors[field.key]}</p>
              ) : (
                field.help && <p className="mt-1 text-xs text-text-muted">{field.help}</p>
              )}
            </div>
          ))}

          {submitError && (
            <p className="rounded-lg border border-status-error/20 bg-status-error/10 px-3 py-2 text-sm text-status-error">
              {submitError}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={submitting}
              className="bg-accent-cyan hover:bg-accent-cyan-bright text-bg-deepest font-medium"
            >
              {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
              {editing ? 'Save' : 'Add app'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
