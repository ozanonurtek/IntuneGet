/**
 * Manual App Mappings API Route
 * CRUD operations for user-created app-to-WinGet mappings
 */

import { NextRequest, NextResponse } from 'next/server';
import { createServerClient, isSupabaseServerConfigured } from '@/lib/supabase';
import { resolveTargetTenantId } from '@/lib/msp/tenant-resolution';
import { parseAccessToken } from '@/lib/auth-utils';
import { getDatabase, isSqliteMode } from '@/lib/db';
import type { ManualAppMappingRecord } from '@/lib/db';
import type { ManualAppMapping, CreateMappingRequest } from '@/types/unmanaged';
import type { Database } from '@/types/database';

// Database row types from the Database schema
type ManualMappingRow = Database['public']['Tables']['manual_app_mappings']['Row'];

/**
 * Manual mappings are stored in Supabase when it is configured. A SQLite self
 * hosted deployment without Supabase stores them in its own database for the
 * signed in tenant; any other deployment without Supabase cannot store them.
 */
function mappingStorage(): 'supabase' | 'sqlite' | null {
  if (isSupabaseServerConfigured()) return 'supabase';
  return isSqliteMode() ? 'sqlite' : null;
}

/**
 * GET - List all manual mappings for the tenant
 */
export async function GET(request: NextRequest) {
  try {
    const user = await parseAccessToken(request.headers.get('Authorization'));
    if (!user) {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      );
    }

    const storage = mappingStorage();
    if (!storage) {
      return NextResponse.json({ mappings: [] });
    }

    if (storage === 'sqlite') {
      const mappings = await getDatabase().manualAppMappings.listForTenant(user.tenantId);
      return NextResponse.json({ mappings: mappings.map(formatMapping) });
    }

    const supabase = createServerClient();
    const mspTenantId = request.headers.get('X-MSP-Tenant-Id');

    const tenantResolution = await resolveTargetTenantId({
      supabase,
      userId: user.userId,
      tokenTenantId: user.tenantId,
      requestedTenantId: mspTenantId,
    });

    if (tenantResolution.errorResponse) {
      return tenantResolution.errorResponse;
    }

    const tenantId = tenantResolution.tenantId;

    // Get mappings for this tenant and global mappings
    const { data: mappings, error } = await supabase
      .from('manual_app_mappings')
      .select('*')
      .or(`tenant_id.eq.${tenantId},tenant_id.is.null`)
      .order('created_at', { ascending: false });

    if (error) {
      return NextResponse.json(
        { error: 'Failed to fetch mappings' },
        { status: 500 }
      );
    }

    const formattedMappings: ManualAppMapping[] = (mappings || []).map(m => ({
      id: m.id,
      discoveredAppName: m.discovered_app_name,
      discoveredPublisher: m.discovered_publisher,
      wingetPackageId: m.winget_package_id,
      createdBy: m.created_by,
      tenantId: m.tenant_id,
      isVerified: m.is_verified,
      createdAt: m.created_at,
      updatedAt: m.updated_at,
    }));

    return NextResponse.json({ mappings: formattedMappings });
  } catch {
    return NextResponse.json(
      { error: 'Failed to fetch mappings' },
      { status: 500 }
    );
  }
}

/**
 * POST - Create a new manual mapping
 */
export async function POST(request: NextRequest) {
  const storage = mappingStorage();
  if (!storage) {
    return NextResponse.json(
      { error: 'Manual mappings require hosted services' },
      { status: 503 }
    );
  }
  try {
    const user = await parseAccessToken(request.headers.get('Authorization'));
    if (!user) {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      );
    }

    const body: CreateMappingRequest = await request.json();

    if (!body.discoveredAppName || !body.wingetPackageId) {
      return NextResponse.json(
        { error: 'Missing required fields: discoveredAppName and wingetPackageId' },
        { status: 400 }
      );
    }

    if (storage === 'sqlite') {
      const { mapping, updated } = await getDatabase().manualAppMappings.upsert({
        discovered_app_name: body.discoveredAppName,
        discovered_publisher: body.discoveredPublisher ?? null,
        winget_package_id: body.wingetPackageId,
        tenant_id: user.tenantId,
        created_by: user.userId,
      });

      if (updated) {
        return NextResponse.json({
          mapping: formatMapping(mapping),
          updated: true,
        });
      }

      return NextResponse.json({
        mapping: formatMapping(mapping),
        updated: false,
      }, { status: 201 });
    }

    const supabase = createServerClient();
    const mspTenantId = request.headers.get('X-MSP-Tenant-Id');

    const tenantResolution = await resolveTargetTenantId({
      supabase,
      userId: user.userId,
      tokenTenantId: user.tenantId,
      requestedTenantId: mspTenantId,
    });

    if (tenantResolution.errorResponse) {
      return tenantResolution.errorResponse;
    }

    const tenantId = tenantResolution.tenantId;

    // Check if mapping already exists
    const { data: existing } = await supabase
      .from('manual_app_mappings')
      .select('id')
      .eq('discovered_app_name', body.discoveredAppName.toLowerCase().trim())
      .eq('tenant_id', tenantId)
      .single();

    if (existing) {
      // Update existing mapping
      const { data: updated, error } = await supabase
        .from('manual_app_mappings')
        .update({
          winget_package_id: body.wingetPackageId,
          discovered_publisher: body.discoveredPublisher || null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.id)
        .select()
        .single();

      if (error || !updated) {
        return NextResponse.json(
          { error: 'Failed to update mapping' },
          { status: 500 }
        );
      }

      return NextResponse.json({
        mapping: formatMapping(updated),
        updated: true,
      });
    }

    // Create new mapping
    const { data: created, error } = await supabase
      .from('manual_app_mappings')
      .insert({
        discovered_app_name: body.discoveredAppName.toLowerCase().trim(),
        discovered_publisher: body.discoveredPublisher || null,
        winget_package_id: body.wingetPackageId,
        created_by: user.userId,
        tenant_id: tenantId,
        is_verified: false,
      })
      .select()
      .single();

    if (error || !created) {
      return NextResponse.json(
        { error: 'Failed to create mapping' },
        { status: 500 }
      );
    }

    // Update the discovered apps cache to reflect the new mapping
    await supabase
      .from('discovered_apps_cache')
      .update({
        matched_package_id: body.wingetPackageId,
        match_status: 'matched',
        match_confidence: 1.0,
      })
      .eq('tenant_id', tenantId)
      .ilike('display_name', body.discoveredAppName);

    return NextResponse.json({
      mapping: formatMapping(created),
      updated: false,
    }, { status: 201 });
  } catch {
    return NextResponse.json(
      { error: 'Failed to create mapping' },
      { status: 500 }
    );
  }
}

/**
 * DELETE - Remove a manual mapping
 */
export async function DELETE(request: NextRequest) {
  const storage = mappingStorage();
  if (!storage) {
    return NextResponse.json(
      { error: 'Manual mappings require hosted services' },
      { status: 503 }
    );
  }
  try {
    const user = await parseAccessToken(request.headers.get('Authorization'));
    if (!user) {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      );
    }

    const { searchParams } = new URL(request.url);
    const mappingId = searchParams.get('id');

    if (!mappingId) {
      return NextResponse.json(
        { error: 'Missing mapping ID' },
        { status: 400 }
      );
    }

    if (storage === 'sqlite') {
      const mapping = await getDatabase().manualAppMappings.getById(mappingId);
      if (!mapping) {
        return NextResponse.json(
          { error: 'Mapping not found' },
          { status: 404 }
        );
      }

      // Only allow deletion by tenant members, as the hosted route does
      if (mapping.tenant_id !== user.tenantId) {
        return NextResponse.json(
          { error: 'Unauthorized to delete this mapping' },
          { status: 403 }
        );
      }

      await getDatabase().manualAppMappings.delete(mappingId, user.tenantId);

      return NextResponse.json({
        success: true,
      });
    }

    const supabase = createServerClient();
    const mspTenantId = request.headers.get('X-MSP-Tenant-Id');

    const tenantResolution = await resolveTargetTenantId({
      supabase,
      userId: user.userId,
      tokenTenantId: user.tenantId,
      requestedTenantId: mspTenantId,
    });

    if (tenantResolution.errorResponse) {
      return tenantResolution.errorResponse;
    }

    const tenantId = tenantResolution.tenantId;

    // Get the mapping first to verify ownership
    const { data: mapping, error: fetchError } = await supabase
      .from('manual_app_mappings')
      .select('*')
      .eq('id', mappingId)
      .single();

    if (fetchError || !mapping) {
      return NextResponse.json(
        { error: 'Mapping not found' },
        { status: 404 }
      );
    }

    // Only allow deletion by creator or tenant members
    if (mapping.tenant_id !== tenantId) {
      return NextResponse.json(
        { error: 'Unauthorized to delete this mapping' },
        { status: 403 }
      );
    }

    // Delete the mapping
    const { error: deleteError } = await supabase
      .from('manual_app_mappings')
      .delete()
      .eq('id', mappingId);

    if (deleteError) {
      return NextResponse.json(
        { error: 'Failed to delete mapping' },
        { status: 500 }
      );
    }

    // Update the discovered apps cache to remove the mapping
    await supabase
      .from('discovered_apps_cache')
      .update({
        matched_package_id: null,
        match_status: 'unmatched',
        match_confidence: 0,
      })
      .eq('tenant_id', tenantId)
      .ilike('display_name', mapping.discovered_app_name);

    return NextResponse.json({
      success: true,
    });
  } catch {
    return NextResponse.json(
      { error: 'Failed to delete mapping' },
      { status: 500 }
    );
  }
}

function formatMapping(m: ManualMappingRow | ManualAppMappingRecord): ManualAppMapping {
  return {
    id: m.id,
    discoveredAppName: m.discovered_app_name,
    discoveredPublisher: m.discovered_publisher,
    wingetPackageId: m.winget_package_id,
    createdBy: m.created_by,
    tenantId: m.tenant_id,
    isVerified: m.is_verified,
    createdAt: m.created_at,
    updatedAt: m.updated_at,
  };
}
