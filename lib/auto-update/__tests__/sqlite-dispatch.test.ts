import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const triggerPackagingWorkflowMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/github-actions', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  triggerPackagingWorkflow: triggerPackagingWorkflowMock,
}));

let tempDir: string;

beforeEach(() => {
  vi.resetModules();
  tempDir = mkdtempSync(join(tmpdir(), 'intuneget-autoupdate-dispatch-'));
  process.env.DATABASE_PATH = join(tempDir, 'app.db');
  triggerPackagingWorkflowMock.mockReset();
});

afterEach(async () => {
  const { closeSqliteDb } = await import('@/lib/db/sqlite');
  closeSqliteDb();
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.DATABASE_PATH;
  delete process.env.PACKAGER_MODE;
  delete process.env.GITHUB_PAT;
  delete process.env.GITHUB_OWNER;
  delete process.env.GITHUB_WORKFLOWS_REPO;
});

async function load() {
  const { sqliteDb } = await import('@/lib/db/sqlite');
  const { triggerSqliteAutoUpdate } = await import('@/lib/auto-update/sqlite');
  return { db: sqliteDb, triggerSqliteAutoUpdate };
}

const deploymentConfig = {
  displayName: 'Vendor App',
  publisher: 'Vendor',
  architecture: 'x64',
  installerType: 'exe',
  installCommand: 'app.exe /s',
  uninstallCommand: 'app.exe /x',
  installScope: 'machine',
  detectionRules: [],
};

async function seedPolicy(db: Awaited<ReturnType<typeof load>>['db']) {
  return db.updatePolicies.upsert({
    user_id: 'u1',
    tenant_id: 't1',
    winget_id: 'Vendor.App',
    policy_type: 'auto_update',
    deployment_config: deploymentConfig,
    original_upload_history_id: 'u1-history',
    is_enabled: true,
  });
}

function updateInfo() {
  return {
    wingetId: 'Vendor.App',
    currentVersion: '1.0.0',
    latestVersion: '2.0.0',
    currentIntuneAppId: 'app-1',
    displayName: 'Vendor App',
    installerUrl: 'https://example.com/app-2.0.0.exe',
    installerSha256: 'A'.repeat(64),
    installerType: 'exe',
    installCommand: 'app.exe /s',
    uninstallCommand: 'app.exe /x',
    installScope: 'machine',
  };
}

describe('sqlite auto-update GitHub Actions dispatch', () => {
  it('dispatches the queued job to GitHub Actions in github packager mode and records the run', async () => {
    process.env.PACKAGER_MODE = 'github';
    process.env.GITHUB_PAT = 'test-pat';
    process.env.GITHUB_OWNER = 'aras-digital';
    process.env.GITHUB_WORKFLOWS_REPO = 'intuneget-workflows';
    triggerPackagingWorkflowMock.mockResolvedValue({
      success: true,
      runId: 987654321,
      runUrl: 'https://github.com/aras-digital/intuneget-workflows/actions/runs/987654321',
    });

    const { db, triggerSqliteAutoUpdate } = await load();
    const policy = await seedPolicy(db);
    const result = await triggerSqliteAutoUpdate(db, policy, updateInfo(), {
      skipRateLimits: true,
      skipPriorDeploymentCheck: true,
    });

    expect(result.success).toBe(true);
    expect(triggerPackagingWorkflowMock).toHaveBeenCalledOnce();

    const [inputs, config, options] = triggerPackagingWorkflowMock.mock.calls[0];
    expect(inputs).toMatchObject({
      jobId: result.packagingJobId,
      tenantId: 't1',
      wingetId: 'Vendor.App',
      version: '2.0.0',
      installerSha256: 'A'.repeat(64),
      sourceIntuneAppId: 'app-1',
      autoSupersede: true,
      supersedenceType: 'update',
      forceCreate: true,
      installScope: 'machine',
    });
    expect(config).toBeUndefined();
    expect(options).toEqual({ requireQaPass: true });

    const job = await db.jobs.getById(result.packagingJobId!);
    expect(job?.status).toBe('packaging');
    expect(job?.github_run_id).toBe('987654321');
    expect(job?.github_run_url).toBe(
      'https://github.com/aras-digital/intuneget-workflows/actions/runs/987654321'
    );
    expect(job?.packaging_started_at).toBeTruthy();

    const history = await db.autoUpdateHistory.list('u1', { limit: 10, offset: 0 });
    expect(history[0]?.status).toBe('packaging');
    expect(history[0]?.packaging_job_id).toBe(result.packagingJobId);
  });

  it('marks the job and history row failed when the dispatch fails', async () => {
    process.env.PACKAGER_MODE = 'github';
    process.env.GITHUB_PAT = 'test-pat';
    process.env.GITHUB_OWNER = 'aras-digital';
    process.env.GITHUB_WORKFLOWS_REPO = 'intuneget-workflows';
    triggerPackagingWorkflowMock.mockRejectedValue(new Error('GitHub dispatch failed'));

    const { db, triggerSqliteAutoUpdate } = await load();
    const policy = await seedPolicy(db);
    const result = await triggerSqliteAutoUpdate(db, policy, updateInfo(), {
      skipRateLimits: true,
      skipPriorDeploymentCheck: true,
    });

    expect(result).toMatchObject({ success: false, error: 'GitHub dispatch failed' });

    const job = await db.jobs.getById(result.packagingJobId!);
    expect(job?.status).toBe('failed');
    expect(job?.error_message).toBe('GitHub dispatch failed');

    const history = await db.autoUpdateHistory.list('u1', { limit: 10, offset: 0 });
    expect(history[0]?.status).toBe('failed');
    expect(history[0]?.error_message).toBe('GitHub dispatch failed');
    expect(history[0]?.packaging_job_id).toBe(result.packagingJobId);
  });

  it('leaves the job queued for the local packager', async () => {
    process.env.PACKAGER_MODE = 'local';
    process.env.PACKAGER_API_KEY = 'local-key';

    const { db, triggerSqliteAutoUpdate } = await load();
    const policy = await seedPolicy(db);
    const result = await triggerSqliteAutoUpdate(db, policy, updateInfo(), {
      skipRateLimits: true,
      skipPriorDeploymentCheck: true,
    });

    expect(result.success).toBe(true);
    expect(triggerPackagingWorkflowMock).not.toHaveBeenCalled();

    const job = await db.jobs.getById(result.packagingJobId!);
    expect(job?.status).toBe('queued');
    expect(job?.github_run_id).toBeNull();

    delete process.env.PACKAGER_API_KEY;
  });

  it('skips the dispatch when GitHub Actions is not configured', async () => {
    process.env.PACKAGER_MODE = 'github';
    delete process.env.GITHUB_PAT;

    const { db, triggerSqliteAutoUpdate } = await load();
    const policy = await seedPolicy(db);
    const result = await triggerSqliteAutoUpdate(db, policy, updateInfo(), {
      skipRateLimits: true,
      skipPriorDeploymentCheck: true,
    });

    expect(result.success).toBe(true);
    expect(triggerPackagingWorkflowMock).not.toHaveBeenCalled();
    expect((await db.jobs.getById(result.packagingJobId!))?.status).toBe('queued');
  });
});
