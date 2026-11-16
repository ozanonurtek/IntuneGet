/**
 * GET  /api/macos/custom-apps: the tenant's custom macOS apps.
 * POST /api/macos/custom-apps: define one (name, publisher, version, bundleId,
 *      url, sha256, description?, homepage?, iconUrl?).
 */

import { NextRequest, NextResponse } from 'next/server';
import { customAppErrorResponse, parseCustomAppBody } from '@/lib/macos/custom-app-request';
import { createCustomApp, listCustomApps } from '@/lib/macos/custom-apps';
import { errorMessage, gateMacosRequest } from '@/lib/macos/route-auth';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const gate = await gateMacosRequest(request);
  if (!gate.ok) return gate.response;
  try {
    const search = new URL(request.url).searchParams.get('search') || undefined;
    const apps = listCustomApps(gate.ctx.tenantId, search);
    return NextResponse.json({ apps, count: apps.length });
  } catch (error) {
    console.error('[macos] custom app listing failed:', errorMessage(error));
    return NextResponse.json({ error: 'Failed to list custom apps' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const gate = await gateMacosRequest(request);
  if (!gate.ok) return gate.response;
  const body = await parseCustomAppBody(request);
  if (!body.ok) return body.response;
  try {
    const app = createCustomApp(gate.ctx.tenantId, gate.ctx.userEmail || gate.ctx.userId, body.input);
    return NextResponse.json({ app }, { status: 201 });
  } catch (error) {
    return customAppErrorResponse(error, 'create');
  }
}
