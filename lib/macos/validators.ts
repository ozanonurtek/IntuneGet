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
