/**
 * PATCH  /api/macos/tenant-apps/[id]/assignments/[assignmentId]: change the intent ({ intent }).
 * DELETE /api/macos/tenant-apps/[id]/assignments/[assignmentId]: remove the assignment.
 *
 * Only assignments of macOS PKG/DMG/LOB apps of the caller's tenant; anything else is 404.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getMacApp, listAppAssignments } from '@/lib/macos/assignments';
import { GraphRequestError } from '@/lib/macos/graph';
import { createGraphClientForTenant } from '@/lib/macos/jobs';
import { errorMessage, gateMacosRequest } from '@/lib/macos/route-auth';
import { ASSIGNMENT_ID_PATTERN, INTUNE_APP_ID_PATTERN, macosAssignmentIntentSchema } from '@/lib/macos/validators';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type RouteContext = { params: Promise<{ id: string; assignmentId: string }> };

const notFound = () => NextResponse.json({ error: 'The assignment was not found' }, { status: 404 });

function graphFailure(error: unknown, action: string) {
  if (error instanceof GraphRequestError && error.status === 404) return notFound();
  console.error(`[macos] ${action} failed:`, errorMessage(error));
  return NextResponse.json({ error: `${action} failed: ${errorMessage(error)}` }, { status: 502 });
}

/** The app and the assignment, both verified to belong to the tenant's macOS app. */
async function resolve(request: NextRequest, params: RouteContext['params']) {
  const gate = await gateMacosRequest(request);
  if (!gate.ok) return { response: gate.response } as const;
  const { id, assignmentId } = await params;
  if (!INTUNE_APP_ID_PATTERN.test(id) || !ASSIGNMENT_ID_PATTERN.test(assignmentId)) return { response: notFound() } as const;
  const graph = createGraphClientForTenant(gate.ctx.tenantId);
  const app = await getMacApp(graph, id);
  if (!app) return { response: notFound() } as const;
  const assignment = (await listAppAssignments(graph, id)).find((a) => a.id === assignmentId);
  if (!assignment) return { response: notFound() } as const;
  return { gate, graph, app, assignment, id } as const;
}

function label(a: { groupName: string | null; groupId: string | null; targetKind: string }) {
  return a.groupName || a.groupId || a.targetKind;
}

export async function PATCH(request: NextRequest, { params }: RouteContext) {
  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    body = null;
  }
  try {
    const r = await resolve(request, params);
    if ('response' in r) return r.response;
    const parsed = macosAssignmentIntentSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: 'intent must be required, available or uninstall' }, { status: 400 });
    const { intent } = parsed.data;
    if (r.assignment.intent !== intent) {
      await r.graph.updateAssignmentIntent(r.id, r.assignment.id, intent);
      console.info(
        `[macos] ${r.gate.ctx.userEmail || r.gate.ctx.userId} changed ${r.app.displayName} (${r.id}) assignment ${label(r.assignment)}: ${r.assignment.intent} -> ${intent}`
      );
    }
    return NextResponse.json({ assignments: await listAppAssignments(r.graph, r.id) });
  } catch (error) {
    return graphFailure(error, 'Changing the assignment');
  }
}

export async function DELETE(request: NextRequest, { params }: RouteContext) {
  try {
    const r = await resolve(request, params);
    if ('response' in r) return r.response;
    await r.graph.deleteAssignment(r.id, r.assignment.id);
    console.info(
      `[macos] ${r.gate.ctx.userEmail || r.gate.ctx.userId} removed ${r.app.displayName} (${r.id}) assignment ${label(r.assignment)} (${r.assignment.intent})`
    );
    return NextResponse.json({ assignments: await listAppAssignments(r.graph, r.id) });
  } catch (error) {
    return graphFailure(error, 'Removing the assignment');
  }
}
