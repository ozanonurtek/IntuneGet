/**
 * GET  /api/macos/tenant-apps/[id]/assignments: the app's assignments, with group names.
 * POST /api/macos/tenant-apps/[id]/assignments: add a group ({ groupId, groupName, intent }).
 *
 * Only macOS PKG/DMG/LOB apps of the caller's tenant; anything else is 404.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getMacApp, listAppAssignments } from '@/lib/macos/assignments';
import { GraphRequestError } from '@/lib/macos/graph';
import { createGraphClientForTenant } from '@/lib/macos/jobs';
import { errorMessage, gateMacosRequest } from '@/lib/macos/route-auth';
import { INTUNE_APP_ID_PATTERN, macosAssignmentSchema } from '@/lib/macos/validators';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type RouteContext = { params: Promise<{ id: string }> };

const notFound = () => NextResponse.json({ error: 'The Intune macOS app was not found' }, { status: 404 });

function graphFailure(error: unknown, action: string) {
  if (error instanceof GraphRequestError && error.status === 404) return notFound();
  console.error(`[macos] ${action} failed:`, errorMessage(error));
  return NextResponse.json({ error: `${action} failed: ${errorMessage(error)}` }, { status: 502 });
}

export async function GET(request: NextRequest, { params }: RouteContext) {
  const gate = await gateMacosRequest(request);
  if (!gate.ok) return gate.response;
  const { id } = await params;
  if (!INTUNE_APP_ID_PATTERN.test(id)) return notFound();
  const graph = createGraphClientForTenant(gate.ctx.tenantId);
  try {
    if (!(await getMacApp(graph, id))) return notFound();
    return NextResponse.json({ assignments: await listAppAssignments(graph, id) });
  } catch (error) {
    return graphFailure(error, 'Reading the assignments');
  }
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  const gate = await gateMacosRequest(request);
  if (!gate.ok) return gate.response;
  const { id } = await params;
  if (!INTUNE_APP_ID_PATTERN.test(id)) return notFound();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Request body must be JSON' }, { status: 400 });
  }
  const parsed = macosAssignmentSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues.map((i) => i.message).join('; ') || 'Invalid request' }, { status: 400 });
  }
  const input = parsed.data;
  const graph = createGraphClientForTenant(gate.ctx.tenantId);
  try {
    const app = await getMacApp(graph, id);
    if (!app) return notFound();
    const existing = await listAppAssignments(graph, id);
    if (existing.some((a) => a.groupId?.toLowerCase() === input.groupId.toLowerCase())) {
      return NextResponse.json(
        { error: `${input.groupName || input.groupId} is already assigned to ${app.displayName}; change its intent instead.` },
        { status: 409 }
      );
    }
    await graph.addAssignment(id, input);
    console.info(
      `[macos] ${gate.ctx.userEmail || gate.ctx.userId} assigned ${app.displayName} (${id}) to ${input.groupName || input.groupId} as ${input.intent}`
    );
    return NextResponse.json({ assignments: await listAppAssignments(graph, id) }, { status: 201 });
  } catch (error) {
    return graphFailure(error, 'Adding the assignment');
  }
}
