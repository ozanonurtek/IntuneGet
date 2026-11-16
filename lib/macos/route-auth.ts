/**
 * Shared request gate for /api/macos routes: SQLite mode only, a signed-in
 * user, and the target tenant resolved the same way as /api/intune/groups.
 */

import { NextRequest, NextResponse } from 'next/server';
import { parseAccessToken } from '@/lib/auth-utils';
import { isSqliteMode } from '@/lib/db';
import { resolveTargetTenantId } from '@/lib/msp/tenant-resolution';
import { getServerClientOrNull } from '@/lib/supabase';

export interface MacosRequestContext {
  userId: string;
  userEmail: string | null;
  tenantId: string;
}

export type MacosGateResult = { ok: true; ctx: MacosRequestContext } | { ok: false; response: NextResponse };

export function sqliteOnlyResponse(): NextResponse {
  return NextResponse.json(
    { error: 'The macOS module is available only on self-hosted (SQLite) deployments.' },
    { status: 501 }
  );
}

export async function gateMacosRequest(request: NextRequest): Promise<MacosGateResult> {
  if (!isSqliteMode()) return { ok: false, response: sqliteOnlyResponse() };

  const user = await parseAccessToken(request.headers.get('Authorization'));
  if (!user) {
    return { ok: false, response: NextResponse.json({ error: 'Authentication required' }, { status: 401 }) };
  }

  const supabase = getServerClientOrNull();
  const tenantResolution = supabase
    ? await resolveTargetTenantId({
        supabase,
        userId: user.userId,
        tokenTenantId: user.tenantId,
        requestedTenantId: request.headers.get('X-MSP-Tenant-Id'),
      })
    : { tenantId: user.tenantId, errorResponse: null };
  if (tenantResolution.errorResponse) return { ok: false, response: tenantResolution.errorResponse };

  return {
    ok: true,
    ctx: { userId: user.userId, userEmail: user.userEmail || null, tenantId: tenantResolution.tenantId },
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unexpected error';
}
