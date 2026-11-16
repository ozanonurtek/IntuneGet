/**
 * POST /api/macos/deploy
 * Body: { catalogId, mode: 'new' | 'update', intuneAppId?, assignments, ignoreVersionDetection? }
 *
 * Queues a deploy of an IntuneBrew catalog app or one of the tenant's custom
 * apps (catalogId `custom-...`): a new Intune app with group
 * assignments, or a new content version on an existing PKG/DMG app (its
 * assignments are left untouched).
 */

import { NextRequest, NextResponse } from 'next/server';
import { logoUrl } from '@/lib/macos/catalog';
import { GraphRequestError } from '@/lib/macos/graph';
import { appTypeForFileName } from '@/lib/macos/intune-upload';
import { createGraphClientForTenant, enqueueMacosJob } from '@/lib/macos/jobs';
import { errorMessage, gateMacosRequest } from '@/lib/macos/route-auth';
import { resolveDeployableApp } from '@/lib/macos/custom-apps';
import { ActiveJobExistsError } from '@/lib/macos/store';
import { isCustomAppId } from '@/lib/macos/types';
import { listIntuneMacApps, parseIntuneMacApp } from '@/lib/macos/tenant-apps';
import { macosDeploySchema } from '@/lib/macos/validators';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const gate = await gateMacosRequest(request);
  if (!gate.ok) return gate.response;
  const { ctx } = gate;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Request body must be JSON' }, { status: 400 });
  }
  const parsed = macosDeploySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((issue) => issue.message).join('; ') || 'Invalid request' },
      { status: 400 }
    );
  }
  const input = parsed.data;

  // Custom ids resolve only within the caller's tenant.
  const resolved = resolveDeployableApp(input.catalogId, ctx.tenantId, logoUrl);
  if (!resolved) {
    return NextResponse.json(
      { error: isCustomAppId(input.catalogId) ? 'The custom app was not found' : 'The app is not in the macOS catalog' },
      { status: 404 }
    );
  }
  const { app } = resolved;
  const installerType = appTypeForFileName(app.fileName);
  const graph = createGraphClientForTenant(ctx.tenantId);

  try {
    if (input.mode === 'new') {
      const existing = (await listIntuneMacApps(graph)).find(
        (candidate) => candidate.bundleId && candidate.bundleId.toLowerCase() === app.bundleId.toLowerCase()
      );
      if (existing) {
        return NextResponse.json(
          {
            error: `Intune already has a macOS app for ${app.bundleId} ("${existing.displayName}"). Use Update on the "Our Macs' apps" tab instead of creating a duplicate.`,
            intuneAppId: existing.id,
          },
          { status: 409 }
        );
      }
    } else {
      const target = parseIntuneMacApp(await graph.getApp(input.intuneAppId!));
      if (!target || target.appType === 'macOSLobApp') {
        return NextResponse.json(
          { error: 'Only macOS PKG and DMG apps can be updated with a new content version.' },
          { status: 409 }
        );
      }
      if (target.appType !== installerType) {
        return NextResponse.json(
          {
            error: `The Intune app is a ${target.appType === 'macOSPkgApp' ? 'PKG' : 'DMG'} app but the installer is a ${installerType === 'macOSPkgApp' ? 'PKG' : 'DMG'}; it cannot be updated in place.`,
          },
          { status: 409 }
        );
      }
    }
  } catch (error) {
    if (error instanceof GraphRequestError && error.status === 404) {
      return NextResponse.json({ error: 'The Intune app was not found' }, { status: 404 });
    }
    console.error('[macos] deploy pre-check failed:', errorMessage(error));
    return NextResponse.json({ error: `Could not check Intune: ${errorMessage(error)}` }, { status: 502 });
  }

  try {
    const job = enqueueMacosJob({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      userEmail: ctx.userEmail,
      catalogId: app.id,
      appName: app.name,
      version: app.version,
      mode: input.mode,
      intuneAppId: input.mode === 'update' ? input.intuneAppId! : null,
      assignments: input.mode === 'new' ? input.assignments : [],
      ignoreVersionDetection: input.ignoreVersionDetection ?? null,
    });
    return NextResponse.json({ job }, { status: 202 });
  } catch (error) {
    if (error instanceof ActiveJobExistsError) {
      return NextResponse.json({ error: error.message, job: error.job }, { status: 409 });
    }
    console.error('[macos] could not queue deploy:', errorMessage(error));
    return NextResponse.json({ error: 'Failed to queue the deployment' }, { status: 500 });
  }
}
