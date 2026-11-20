/**
 * Group assignments of an existing Intune macOS app: read with group names,
 * change the intent, remove, add. Used by "Our Macs' apps" > Assignments.
 */

import type { MacosGraphClient } from './graph';
import { parseIntuneMacApp, type IntuneMacApp } from './tenant-apps';
import type { MacosAppAssignment, MacosAssignmentTargetKind } from './types';

const TARGET_KINDS: Record<string, MacosAssignmentTargetKind> = {
  '#microsoft.graph.groupAssignmentTarget': 'group',
  '#microsoft.graph.exclusionGroupAssignmentTarget': 'excludedGroup',
  '#microsoft.graph.allLicensedUsersAssignmentTarget': 'allUsers',
  '#microsoft.graph.allDevicesAssignmentTarget': 'allDevices',
};

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function parseAppAssignment(raw: Record<string, unknown>): MacosAppAssignment | null {
  const id = str(raw.id);
  if (!id) return null;
  const target = (raw.target && typeof raw.target === 'object' ? raw.target : {}) as Record<string, unknown>;
  const targetKind = TARGET_KINDS[String(target['@odata.type'] || '')] ?? 'other';
  const filterId = str(target.deviceAndAppManagementAssignmentFilterId);
  const filterType = str(target.deviceAndAppManagementAssignmentFilterType);
  return {
    id,
    intent: str(raw.intent) || 'unknown',
    targetKind,
    groupId: targetKind === 'group' || targetKind === 'excludedGroup' ? str(target.groupId) : null,
    groupName: null,
    hasFilter: Boolean(filterId && filterId !== '00000000-0000-0000-0000-000000000000' && filterType !== 'none'),
  };
}

/** The app as a macOS PKG/DMG/LOB app, or null when the id is something else. */
export async function getMacApp(graph: MacosGraphClient, appId: string): Promise<IntuneMacApp | null> {
  return parseIntuneMacApp(await graph.getApp(appId));
}

/** Assignments with group display names (the id is shown when a name cannot be read). */
export async function listAppAssignments(graph: MacosGraphClient, appId: string): Promise<MacosAppAssignment[]> {
  const assignments = (await graph.listAssignments(appId))
    .map(parseAppAssignment)
    .filter((a): a is MacosAppAssignment => a !== null);
  const names = new Map<string, string | null>();
  for (const groupId of new Set(assignments.map((a) => a.groupId).filter((g): g is string => Boolean(g)))) {
    try {
      names.set(groupId, await graph.getGroupName(groupId));
    } catch {
      names.set(groupId, null);
    }
  }
  return assignments.map((a) => ({ ...a, groupName: a.groupId ? names.get(a.groupId) ?? null : null }));
}
