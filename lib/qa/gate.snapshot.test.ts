import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

// Module-level env is captured at import time by lib/supabase, so the SQLite
// self-host environment must be stubbed before the modules under test load
// (the same pattern as app/api/intune/claim/route.sqlite.test.ts).
const { createServerClientMock, getSnapshotDbMock, getQaResultMock } = vi.hoisted(() => {
  vi.stubEnv('DATABASE_PATH', ':memory:');
  vi.stubEnv('DATABASE_MODE', 'sqlite');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');
  return {
    createServerClientMock: vi.fn(),
    getSnapshotDbMock: vi.fn(),
    getQaResultMock: vi.fn(),
  };
});
vi.mock('@/lib/supabase', async () => {
  const actual = await vi.importActual<typeof import('@/lib/supabase')>('@/lib/supabase');
  return { ...actual, createServerClient: createServerClientMock };
});
vi.mock('@/lib/catalog/snapshot-store', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getSnapshotDb: getSnapshotDbMock,
}));
vi.mock('@/lib/catalog', () => ({
  getCatalogSource: () => ({ getQaResult: getQaResultMock }),
}));

import {
  enforceQaGate,
  QaGateNotPassedError,
  QaSecurityGateError,
} from '@/lib/qa/gate';

const installerSha256 = 'A'.repeat(64);

function snapshotFixture() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE qa_results (
      winget_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      publisher TEXT NOT NULL,
      tested_version TEXT NOT NULL,
      architecture TEXT NOT NULL,
      outcome TEXT NOT NULL,
      installer_sha256 TEXT,
      tested_at_utc TEXT NOT NULL,
      overall_duration_seconds REAL,
      installer_type TEXT,
      install_command TEXT NOT NULL,
      uninstall_command TEXT NOT NULL,
      detection TEXT NOT NULL,
      phase_results TEXT NOT NULL,
      changes TEXT,
      relevant_event_count INTEGER,
      environment TEXT,
      effective_configuration TEXT,
      qa_schema_version INTEGER NOT NULL,
      synced_at TEXT NOT NULL,
      test_level TEXT NOT NULL,
      package_profile_sha256 TEXT,
      psadt_version TEXT,
      psadt_template_sha256 TEXT,
      psadt_config_sha256 TEXT,
      detection_rules_sha256 TEXT,
      packager_commit TEXT,
      package_content_sha256 TEXT,
      virustotal_status TEXT,
      virustotal_malicious INTEGER,
      virustotal_suspicious INTEGER,
      virustotal_total_engines INTEGER,
      virustotal_scanned_at_utc TEXT,
      deployment_blocked INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE catalog_file_reputation (
      sha256 TEXT PRIMARY KEY,
      status TEXT,
      malicious INTEGER,
      suspicious INTEGER,
      total_engines INTEGER,
      analyzed_at TEXT
    );
  `);
  return db;
}

function insertQaRow(
  db: Database.Database,
  overrides: Partial<{
    tested_version: string;
    architecture: string;
    outcome: string;
    installer_sha256: string;
  }>
) {
  db.prepare(
    `INSERT INTO qa_results (
      winget_id, display_name, publisher, tested_version, architecture, outcome,
      installer_sha256, tested_at_utc, install_command, uninstall_command,
      detection, phase_results, qa_schema_version, synced_at, test_level, deployment_blocked
    ) VALUES (
      'Vendor.App', 'Vendor App', 'Vendor', @tested_version, @architecture, @outcome,
      @installer_sha256, '2026-10-01T00:00:00Z', 'app.exe /s', 'app.exe /x',
      '{}', '{}', 1, '2026-10-01T00:00:00Z', 'psadt-package', 0
    )`
  ).run({
    tested_version: '2.0.0',
    architecture: 'x64',
    outcome: 'Passed',
    installer_sha256: null,
    ...overrides,
  } as Record<string, unknown>);
}

const gateInput = {
  wingetId: 'Vendor.App',
  version: '2.0.0',
  architecture: 'x64',
  installerSha256,
  packageProfileSha256: 'B'.repeat(64),
};

describe('enforceQaGate in SQLite self-host mode', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = snapshotFixture();
    getSnapshotDbMock.mockReset();
    getSnapshotDbMock.mockResolvedValue(db);
    getQaResultMock.mockReset();
    getQaResultMock.mockResolvedValue(null);
    createServerClientMock.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    db.close();
    vi.mocked(console.warn).mockRestore();
  });

  it('never calls createServerClient for a non-curated winget package', async () => {
    await expect(enforceQaGate(gateInput)).resolves.toBeUndefined();
    expect(createServerClientMock).not.toHaveBeenCalled();
  });

  it('blocks a malicious installer hash from the snapshot without Supabase', async () => {
    db.prepare(
      'INSERT INTO catalog_file_reputation (sha256, status, malicious, suspicious, total_engines, analyzed_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(installerSha256.toLowerCase(), 'found', 5, 2, 72, '2026-10-01T00:00:00Z');

    await expect(enforceQaGate({ ...gateInput, requirePassed: true })).rejects.toBeInstanceOf(
      QaSecurityGateError
    );
    expect(createServerClientMock).not.toHaveBeenCalled();
  });

  it('does not allow a QA override to bypass the snapshot security verdict', async () => {
    db.prepare(
      'INSERT INTO catalog_file_reputation (sha256, status, malicious, suspicious, total_engines, analyzed_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(installerSha256.toLowerCase(), 'found', 1, 0, 72, '2026-10-01T00:00:00Z');

    await expect(enforceQaGate({ ...gateInput, qaOverride: true })).rejects.toBeInstanceOf(
      QaSecurityGateError
    );
    expect(createServerClientMock).not.toHaveBeenCalled();
  });

  it('returns for a passed snapshot row without Supabase', async () => {
    insertQaRow(db, { installer_sha256: installerSha256 });

    await expect(enforceQaGate({ ...gateInput, requirePassed: true })).resolves.toBeUndefined();
    expect(createServerClientMock).not.toHaveBeenCalled();
    expect(getQaResultMock).not.toHaveBeenCalled();
  });

  it('throws QaGateNotPassedError when requirePassed is set and no row exists', async () => {
    await expect(enforceQaGate({ ...gateInput, requirePassed: true })).rejects.toBeInstanceOf(
      QaGateNotPassedError
    );
    expect(createServerClientMock).not.toHaveBeenCalled();
  });

  it('does not allow a QA override to bypass strict automatic QA', async () => {
    await expect(
      enforceQaGate({ ...gateInput, requirePassed: true, qaOverride: true })
    ).rejects.toBeInstanceOf(QaGateNotPassedError);
    expect(createServerClientMock).not.toHaveBeenCalled();
  });

  it('does not crash a plain deploy when the snapshot is unavailable', async () => {
    const { SnapshotUnavailableError } = await import('@/lib/catalog/snapshot-store');
    getSnapshotDbMock.mockRejectedValue(new SnapshotUnavailableError('offline'));

    await expect(enforceQaGate(gateInput)).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(createServerClientMock).not.toHaveBeenCalled();
  });

  it('still requires a passed row when the snapshot is unavailable and requirePassed is set', async () => {
    const { SnapshotUnavailableError } = await import('@/lib/catalog/snapshot-store');
    getSnapshotDbMock.mockRejectedValue(new SnapshotUnavailableError('offline'));

    await expect(enforceQaGate({ ...gateInput, requirePassed: true })).rejects.toBeInstanceOf(
      QaGateNotPassedError
    );
    expect(createServerClientMock).not.toHaveBeenCalled();
  });

  it('falls back to the catalog QA result for an unknown installer sha', async () => {
    getQaResultMock.mockResolvedValue(null);

    await expect(
      enforceQaGate({ ...gateInput, installerSha256: 'C'.repeat(64) })
    ).resolves.toBeUndefined();
    expect(getQaResultMock).toHaveBeenCalledWith('Vendor.App');
    expect(createServerClientMock).not.toHaveBeenCalled();
  });
});
