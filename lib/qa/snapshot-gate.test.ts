import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SnapshotUnavailableError } from '@/lib/catalog/snapshot-store';

const getSnapshotDbMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/catalog/snapshot-store', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getSnapshotDb: getSnapshotDbMock,
}));

import {
  readSnapshotQaEvidence,
  readSnapshotQaEvidenceFromDb,
} from '@/lib/qa/snapshot-gate';

// Tables and columns as published in the catalog-latest snapshot
// (PRAGMA table_info on catalog.sqlite from the catalog-latest release).
function fixtureDb(withReputationTable = true) {
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
  `);
  if (withReputationTable) {
    db.exec(`
      CREATE TABLE catalog_file_reputation (
        sha256 TEXT PRIMARY KEY,
        status TEXT,
        malicious INTEGER,
        suspicious INTEGER,
        total_engines INTEGER,
        analyzed_at TEXT
      );
    `);
  }
  return db;
}

function insertQaRow(
  db: Database.Database,
  overrides: Partial<{
    winget_id: string;
    tested_version: string;
    architecture: string;
    outcome: string;
    installer_sha256: string;
    virustotal_status: string | null;
    virustotal_malicious: number | null;
    virustotal_suspicious: number | null;
    virustotal_total_engines: number | null;
    virustotal_scanned_at_utc: string | null;
  }>
) {
  db.prepare(
    `INSERT INTO qa_results (
      winget_id, display_name, publisher, tested_version, architecture, outcome,
      installer_sha256, tested_at_utc, install_command, uninstall_command,
      detection, phase_results, qa_schema_version, synced_at, test_level,
      virustotal_status, virustotal_malicious, virustotal_suspicious,
      virustotal_total_engines, virustotal_scanned_at_utc, deployment_blocked
    ) VALUES (
      @winget_id, 'Fixture App', 'Fixture Vendor', @tested_version, @architecture, @outcome,
      @installer_sha256, @tested_at_utc, 'app.exe /s', 'app.exe /x',
      '{}', '{}', 1, '2026-10-01T00:00:00Z', 'psadt-package',
      @virustotal_status, @virustotal_malicious, @virustotal_suspicious,
      @virustotal_total_engines, @virustotal_scanned_at_utc, 0
    )`
  ).run({
    winget_id: 'Vendor.App',
    tested_version: '2.0.0',
    architecture: 'x64',
    outcome: 'Passed',
    installer_sha256: null,
    tested_at_utc: '2026-10-01T00:00:00Z',
    virustotal_status: null,
    virustotal_malicious: null,
    virustotal_suspicious: null,
    virustotal_total_engines: null,
    virustotal_scanned_at_utc: null,
    ...overrides,
  } as Record<string, unknown>);
}

const installerSha = 'A'.repeat(64);
const query = {
  wingetId: 'Vendor.App',
  version: '2.0.0',
  architecture: 'x64',
  installerSha256: installerSha,
};

describe('snapshot gate evidence', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = fixtureDb();
    getSnapshotDbMock.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    db.close();
    vi.mocked(console.warn).mockRestore();
  });

  it('reads a malicious verdict for the exact installer hash from catalog_file_reputation', () => {
    db.prepare(
      'INSERT INTO catalog_file_reputation (sha256, status, malicious, suspicious, total_engines, analyzed_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(installerSha.toLowerCase(), 'found', 3, 1, 72, '2026-10-01T00:00:00Z');

    const evidence = readSnapshotQaEvidenceFromDb(db, query);
    expect(evidence.available).toBe(true);
    expect(evidence.securityVerdict).toEqual({ malicious: 3, totalEngines: 72 });
  });

  it('does not treat a clean reputation row as malicious', () => {
    db.prepare(
      'INSERT INTO catalog_file_reputation (sha256, status, malicious, suspicious, total_engines, analyzed_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(installerSha.toLowerCase(), 'found', 0, 0, 72, '2026-10-01T00:00:00Z');

    const evidence = readSnapshotQaEvidenceFromDb(db, query);
    expect(evidence.securityVerdict).toEqual({ malicious: 0, totalEngines: 72 });
    expect(evidence.securityVerdict?.malicious ?? 0).toBeLessThan(1);
  });

  it('falls back to the legacy qa_results VirusTotal columns without a reputation row', () => {
    insertQaRow(db, {
      installer_sha256: installerSha.toLowerCase(),
      virustotal_status: 'flagged',
      virustotal_malicious: 2,
      virustotal_suspicious: 0,
      virustotal_total_engines: 70,
      virustotal_scanned_at_utc: '2026-10-01T00:00:00Z',
    });

    const evidence = readSnapshotQaEvidenceFromDb(db, query);
    expect(evidence.securityVerdict).toEqual({ malicious: 2, totalEngines: 70 });
  });

  it('uses the legacy fallback when the reputation table is absent entirely', () => {
    db.close();
    db = fixtureDb(false);
    insertQaRow(db, {
      installer_sha256: installerSha.toUpperCase(),
      virustotal_status: 'flagged',
      virustotal_malicious: 1,
      virustotal_total_engines: 68,
      virustotal_scanned_at_utc: '2026-10-01T00:00:00Z',
    });

    const evidence = readSnapshotQaEvidenceFromDb(db, query);
    expect(evidence.securityVerdict).toEqual({ malicious: 1, totalEngines: 68 });
  });

  it('finds a passed row for the exact winget id, version, architecture and installer sha', () => {
    insertQaRow(db, { installer_sha256: installerSha });

    expect(readSnapshotQaEvidenceFromDb(db, query).hasPassedRow).toBe(true);
  });

  it.each([
    { mismatch: 'version', overrides: { tested_version: '2.0.1' } },
    { mismatch: 'architecture', overrides: { architecture: 'x86' } },
    { mismatch: 'installer sha', overrides: { installer_sha256: 'B'.repeat(64) } },
    { mismatch: 'outcome', overrides: { outcome: 'Failed' } },
  ])('rejects a passed row with a mismatched %s', ({ overrides }) => {
    insertQaRow(db, { installer_sha256: installerSha, ...overrides });

    expect(readSnapshotQaEvidenceFromDb(db, query).hasPassedRow).toBe(false);
  });

  it('matches the installer sha case-insensitively', () => {
    insertQaRow(db, { installer_sha256: installerSha.toLowerCase() });

    expect(readSnapshotQaEvidenceFromDb(db, query).hasPassedRow).toBe(true);
  });

  it('reads the same evidence through the process snapshot handle', async () => {
    insertQaRow(db, { installer_sha256: installerSha });
    getSnapshotDbMock.mockResolvedValue(db);

    await expect(readSnapshotQaEvidence(query)).resolves.toMatchObject({
      available: true,
      hasPassedRow: true,
      securityVerdict: null,
    });
    expect(getSnapshotDbMock).toHaveBeenCalledOnce();
  });

  it('does not crash when the snapshot is unavailable and warns once', async () => {
    getSnapshotDbMock.mockRejectedValue(new SnapshotUnavailableError('no snapshot yet'));

    await expect(readSnapshotQaEvidence(query)).resolves.toEqual({
      available: false,
      securityVerdict: null,
      hasPassedRow: false,
    });
    expect(console.warn).toHaveBeenCalledTimes(1);
  });
});
