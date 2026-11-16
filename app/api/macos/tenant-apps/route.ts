/**
 * GET /api/macos/tenant-apps: the tenant's macOS PKG/DMG/LOB apps in Intune,
 * matched to the tenant's custom apps and the IntuneBrew catalog, with update availability.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createGraphClientForTenant } from '@/lib/macos/jobs';
import { errorMessage, gateMacosRequest } from '@/lib/macos/route-auth';
import { listCustomApps } from '@/lib/macos/custom-apps';
import { listAllCatalogApps } from '@/lib/macos/store';
import { listIntuneMacApps, matchTenantApps } from '@/lib/macos/tenant-apps';
import { customAppToCatalogApp } from '@/lib/macos/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const gate = await gateMacosRequest(request);
  if (!gate.ok) return gate.response;
  try {
    const intuneApps = await listIntuneMacApps(createGraphClientForTenant(gate.ctx.tenantId));
    const custom = listCustomApps(gate.ctx.tenantId).map(customAppToCatalogApp);
    const apps = matchTenantApps(intuneApps, listAllCatalogApps(), custom);
    return NextResponse.json({ apps, count: apps.length });
  } catch (error) {
    console.error('[macos] tenant app listing failed:', errorMessage(error));
    return NextResponse.json({ error: `Failed to list the tenant's macOS apps: ${errorMessage(error)}` }, { status: 502 });
  }
}
