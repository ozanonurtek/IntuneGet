/**
 * PUT    /api/macos/custom-apps/[id]: replace a custom app's fields (bump the
 *        version, URL and SHA-256 to ship an update). 409 while a job runs.
 * DELETE /api/macos/custom-apps/[id]: remove it. 409 while a job runs.
 * Both 404 for ids that are not the caller tenant's.
 */

import { NextRequest, NextResponse } from 'next/server';
import { customAppErrorResponse, parseCustomAppBody } from '@/lib/macos/custom-app-request';
import { CUSTOM_APP_ID_PATTERN, deleteCustomApp, updateCustomApp } from '@/lib/macos/custom-apps';
import { gateMacosRequest } from '@/lib/macos/route-auth';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

function notFound() {
  return NextResponse.json({ error: 'Custom app not found' }, { status: 404 });
}

export async function PUT(request: NextRequest, { params }: RouteContext) {
  const gate = await gateMacosRequest(request);
  if (!gate.ok) return gate.response;
  const { id } = await params;
  if (!CUSTOM_APP_ID_PATTERN.test(id)) return notFound();
  const body = await parseCustomAppBody(request);
  if (!body.ok) return body.response;
  try {
    const app = updateCustomApp(id, gate.ctx.tenantId, body.input);
    return app ? NextResponse.json({ app }) : notFound();
  } catch (error) {
    return customAppErrorResponse(error, 'update');
  }
}

export async function DELETE(request: NextRequest, { params }: RouteContext) {
  const gate = await gateMacosRequest(request);
  if (!gate.ok) return gate.response;
  const { id } = await params;
  if (!CUSTOM_APP_ID_PATTERN.test(id)) return notFound();
  try {
    return deleteCustomApp(id, gate.ctx.tenantId) ? NextResponse.json({ deleted: true }) : notFound();
  } catch (error) {
    return customAppErrorResponse(error, 'delete');
  }
}
