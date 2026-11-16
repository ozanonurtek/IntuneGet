/**
 * GET /api/macos/jobs/[id]: one macOS deploy job of the tenant.
 */

import { NextRequest, NextResponse } from 'next/server';
import { gateMacosRequest } from '@/lib/macos/route-auth';
import { getJobForTenant } from '@/lib/macos/store';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await gateMacosRequest(request);
  if (!gate.ok) return gate.response;
  const { id } = await params;
  const job = getJobForTenant(id, gate.ctx.tenantId);
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  return NextResponse.json({ job });
}
