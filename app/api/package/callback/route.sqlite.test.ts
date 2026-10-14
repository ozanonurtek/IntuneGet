import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';

const state = vi.hoisted(() => {
  vi.stubEnv('DATABASE_PATH', ':memory:');
  vi.stubEnv('DATABASE_MODE', 'sqlite');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');
  return {};
});
vi.mock('@/lib/supabase', async () => {
  const actual = await vi.importActual<typeof import('@/lib/supabase')>('@/lib/supabase');
  return {
    ...actual,
    isSupabaseConfigured: () => false,
    isSupabaseServerConfigured: () => false,
    createServerClient: vi.fn(actual.createServerClient),
  };
});
vi.mock('@/lib/db', async () => {
  const { sqliteDb } = await vi.importActual<typeof import('@/lib/db/sqlite')>('@/lib/db/sqlite');
  return { getDatabase: () => sqliteDb, isSqliteMode: () => true };
});

import { sqliteDb, closeSqliteDb } from '@/lib/db/sqlite';
import { createServerClient } from '@/lib/supabase';
import { POST } from './route';

const callback = (body: Record<string, unknown>) =>
  POST(new NextRequest('http://localhost/api/package/callback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));

async function seedJob(overrides: Record<string, unknown> = {}) {
  return sqliteDb.jobs.create({
    id: randomUUID(),
    user_id: 'fixture-owner',
    tenant_id: 'fixture-tenant',
    winget_id: 'Fixture.App',
    version: '1.0.0',
    display_name: 'Fixture App',
    installer_type: 'exe',
    installer_url: 'https://example.invalid/fixture.exe',
    status: 'packaging',
    ...overrides,
  });
}

describe('package callback in SQLite mode', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { errorSpy.mockRestore(); });
  afterAll(() => { closeSqliteDb(); vi.unstubAllEnvs(); });

  it('completes a deployed job without touching Supabase or logging errors', async () => {
    const job = await seedJob();

    const response = await callback({
      jobId: job.id,
      status: 'deployed',
      intuneAppId: 'fixture-intune-app',
      intuneAppUrl: 'https://endpoint.microsoft.com/fixture-intune-app',
      message: 'Uploaded to Intune',
    });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.success).toBe(true);
    expect(result.job.status).toBe('deployed');

    expect(createServerClient).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('marks a dispatched auto-update job completed on its history row', async () => {
    const policy = await sqliteDb.updatePolicies.upsert({
      user_id: 'fixture-owner', tenant_id: 'fixture-tenant', winget_id: 'Fixture.App',
      policy_type: 'auto_update', is_enabled: true,
      deployment_config: { displayName: 'Fixture App', architecture: 'x64' },
    });
    const job = await seedJob({
      is_auto_update: true,
      auto_update_policy_id: policy.id,
      package_config: { autoUpdateHistoryId: 'fixture-history' },
    });
    await sqliteDb.autoUpdateHistory.create({
      id: 'fixture-history',
      policy_id: policy.id,
      packaging_job_id: job.id,
      from_version: '1.0.0',
      to_version: '2.0.0',
      update_type: 'minor',
      status: 'packaging',
    });

    const response = await callback({
      jobId: job.id,
      status: 'deployed',
      intuneAppId: 'fixture-intune-app',
      message: 'Uploaded to Intune',
    });
    expect(response.status).toBe(200);

    // The cleanup runs as a fire-and-forget side effect of the callback.
    await vi.waitFor(async () => {
      const rows = await sqliteDb.autoUpdateHistory.list('fixture-owner', { limit: 10, offset: 0 });
      expect(rows.find((row) => row.id === 'fixture-history')?.status).toBe('completed');
    });

    const storedPolicy = await sqliteDb.updatePolicies.getById(policy.id, 'fixture-owner');
    expect(storedPolicy?.consecutive_failures).toBe(0);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(createServerClient).not.toHaveBeenCalled();
  });

  it('marks a failed auto-update job failed and counts the policy failure', async () => {
    const policy = await sqliteDb.updatePolicies.upsert({
      user_id: 'fixture-owner', tenant_id: 'fixture-tenant', winget_id: 'Fixture.Failing',
      policy_type: 'auto_update', is_enabled: true,
      deployment_config: { displayName: 'Failing App', architecture: 'x64' },
      consecutive_failures: 1,
    });
    const job = await seedJob({
      winget_id: 'Fixture.Failing',
      is_auto_update: true,
      auto_update_policy_id: policy.id,
      package_config: { autoUpdateHistoryId: 'fixture-failure-history' },
    });
    await sqliteDb.autoUpdateHistory.create({
      id: 'fixture-failure-history',
      policy_id: policy.id,
      packaging_job_id: job.id,
      from_version: '1.0.0',
      to_version: '2.0.0',
      update_type: 'minor',
      status: 'packaging',
    });

    const response = await callback({
      jobId: job.id,
      status: 'failed',
      message: 'Packaging failed',
      errorStage: 'package',
      errorCategory: 'installer',
    });
    expect(response.status).toBe(200);

    await vi.waitFor(async () => {
      const rows = await sqliteDb.autoUpdateHistory.list('fixture-owner', { limit: 10, offset: 0 });
      const history = rows.find((row) => row.id === 'fixture-failure-history');
      expect(history?.status).toBe('failed');
      expect(history?.error_message).toBe('Packaging failed');
    });

    const storedPolicy = await sqliteDb.updatePolicies.getById(policy.id, 'fixture-owner');
    expect(storedPolicy?.consecutive_failures).toBe(2);
    expect(storedPolicy?.last_auto_update_version).toBeNull();
    expect(storedPolicy?.is_enabled).toBe(true);
    // The failure itself is logged, but never the Supabase configuration noise.
    const logged = errorSpy.mock.calls.map((call) => String(call[0]));
    expect(logged.some((line) => /Batch orchestrator|Auto-update cleanup|Missing Supabase/.test(line))).toBe(false);
    expect(createServerClient).not.toHaveBeenCalled();
  });
});
