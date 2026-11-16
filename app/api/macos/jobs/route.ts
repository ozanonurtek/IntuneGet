/**
 * GET /api/macos/jobs: the tenant's latest 50 macOS deploy jobs.
 */

import { NextRequest, NextResponse } from 'next/server';
import { errorMessage, gateMacosRequest } from '@/lib/macos/route-auth';
import { listJobsForTenant } from '@/lib/macos/store';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const gate = await gateMacosRequest(request);
  if (!gate.ok) return gate.response;
  try {
    return NextResponse.json({ jobs: listJobsForTenant(gate.ctx.tenantId, 50) });
  } catch (error) {
    console.error('[macos] job listing failed:', errorMessage(error));
    return NextResponse.json({ error: 'Failed to list macOS jobs' }, { status: 500 });
  }
}
