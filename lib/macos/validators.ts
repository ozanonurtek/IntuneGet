/**
 * Zod schemas for the macOS API.
 */

import { z } from 'zod';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const macosAssignmentSchema = z.object({
  groupId: z.string().regex(GUID, 'groupId must be an Entra group id'),
  groupName: z.string().trim().max(256).default(''),
  intent: z.enum(['required', 'available', 'uninstall']),
});

export const macosDeploySchema = z
  .object({
    catalogId: z.string().regex(/^[a-z0-9_-]+$/, 'Invalid catalog id').max(128),
    mode: z.enum(['new', 'update']),
    intuneAppId: z.string().regex(GUID, 'intuneAppId must be an Intune app id').optional(),
    assignments: z.array(macosAssignmentSchema).max(50).default([]),
    ignoreVersionDetection: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.mode === 'update' && !value.intuneAppId) {
      ctx.addIssue({ code: 'custom', path: ['intuneAppId'], message: 'intuneAppId is required for an update' });
    }
    if (value.mode === 'update' && value.assignments.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['assignments'],
        message: 'An update keeps the existing assignments; do not send new ones',
      });
    }
    const seen = new Set<string>();
    for (const assignment of value.assignments) {
      const key = assignment.groupId.toLowerCase();
      if (seen.has(key)) {
        ctx.addIssue({ code: 'custom', path: ['assignments'], message: 'Each group can be assigned only once' });
        break;
      }
      seen.add(key);
    }
  });

export type MacosDeployRequest = z.infer<typeof macosDeploySchema>;

export const MACOS_INTENT_ENUM = z.enum(['required', 'available', 'uninstall']);

/** Graph mobileAppAssignment ids look like `<groupId>_<n>_<n>`. */
export const ASSIGNMENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;
export const INTUNE_APP_ID_PATTERN = GUID;

export const macosAssignmentIntentSchema = z.object({ intent: MACOS_INTENT_ENUM });

// ---------------------------------------------------------------------------
// Custom apps
// ---------------------------------------------------------------------------

/** True for IPv4 (as normalised by the URL parser) and bracketed IPv6 hosts. */
function isIpLiteralHost(hostname: string): boolean {
  return hostname.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
}

/**
 * Syntactic checks for a URL the server will fetch later: https, no
 * credentials, a host name rather than an IP literal. The network guard
 * (url-guard.ts) still runs on every fetch.
 */
export function publicHttpsUrlProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'must be a valid URL';
  }
  if (url.protocol !== 'https:') return 'must use https';
  if (url.username || url.password) return 'must not contain credentials';
  if (!url.hostname || isIpLiteralHost(url.hostname)) return 'must use a host name, not an IP address';
  return null;
}

/** The installer file name: the URL path's last segment, decoded. */
export function fileNameFromInstallerUrl(raw: string): string {
  const segment = new URL(raw).pathname.split('/').pop() || '';
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function installerUrlProblem(raw: string): string | null {
  const problem = publicHttpsUrlProblem(raw);
  if (problem) return `Installer URL ${problem}`;
  const fileName = fileNameFromInstallerUrl(raw);
  if (!/\.(pkg|dmg)$/i.test(fileName) || /[\\/]/.test(fileName) || fileName.length < 5) {
    return 'Installer URL path must end with a .pkg or .dmg file name';
  }
  return null;
}

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((value) => value || null);

export const macosCustomAppSchema = z
  .object({
    name: z.string().trim().min(1, 'Name is required').max(256),
    publisher: z.string().trim().min(1, 'Publisher is required').max(256),
    version: z
      .string()
      .trim()
      .min(1, 'Version is required')
      .max(64)
      .regex(/^[0-9A-Za-z][0-9A-Za-z._+-]*$/, 'Version may contain letters, digits and . _ + - only'),
    bundleId: z
      .string()
      .trim()
      .min(1, 'Bundle ID is required')
      .max(255)
      .regex(/^[A-Za-z0-9][A-Za-z0-9.-]*$/, 'Bundle ID may contain letters, digits, dots and hyphens only'),
    url: z.string().trim().max(2048),
    sha256: z
      .string()
      .trim()
      .regex(/^[0-9a-fA-F]{64}$/, 'SHA-256 must be 64 hexadecimal characters')
      .transform((value) => value.toLowerCase()),
    description: optionalText(4000),
    homepage: optionalText(2048),
    iconUrl: optionalText(2048),
  })
  .superRefine((value, ctx) => {
    const installer = installerUrlProblem(value.url);
    if (installer) ctx.addIssue({ code: 'custom', path: ['url'], message: installer });
    if (value.homepage) {
      let ok = false;
      try {
        const protocol = new URL(value.homepage).protocol;
        ok = protocol === 'https:' || protocol === 'http:';
      } catch {
        ok = false;
      }
      if (!ok) ctx.addIssue({ code: 'custom', path: ['homepage'], message: 'Homepage must be an http(s) URL' });
    }
    if (value.iconUrl) {
      const icon = publicHttpsUrlProblem(value.iconUrl);
      if (icon) ctx.addIssue({ code: 'custom', path: ['iconUrl'], message: `Icon URL ${icon}` });
    }
  });

export type MacosCustomAppInput = z.output<typeof macosCustomAppSchema>;
