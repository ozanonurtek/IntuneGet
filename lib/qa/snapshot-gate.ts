/**
 * Snapshot-backed QA gate lookups for SQLite self-host mode.
 *
 * The hosted gate (gate.ts) evaluates compatibility blocks, VirusTotal
 * verdicts and passed QA rows in Supabase. A SQLite self-hosted deployment
 * has no Supabase, but it already downloads the published catalog snapshot
 * (see lib/catalog/snapshot-store.ts); that snapshot ships the same evidence
 * in `catalog_file_reputation` and `qa_results`. These helpers expose the
 * exact lookups the gate needs so they can be unit tested against an
 * in-memory fixture built with the real snapshot schema.
 *
 * The snapshot is always read through the shared read-only handle from
 * snapshot-store.ts; the file is never opened here. snapshot-store is
 * imported lazily so native dependencies stay out of Supabase-mode and edge
 * bundles, exactly like the catalog source modules.
 */

import type BetterSqlite3 from 'better-sqlite3';

type DB = BetterSqlite3.Database;

export interface SnapshotSecurityVerdict {
  malicious: number;
  totalEngines: number | null;
}

export interface SnapshotQaEvidenceQuery {
  wingetId: string;
  version: string;
  architecture: string;
  installerSha256: string;
}

export interface SnapshotQaEvidence {
  /** False when the snapshot itself could not be opened. */
  available: boolean;
  securityVerdict: SnapshotSecurityVerdict | null;
  hasPassedRow: boolean;
}

function tableExists(db: DB, name: string): boolean {
  return Boolean(
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name)
  );
}

function toVerdict(row: {
  malicious: number | null;
  total_engines: number | null;
} | undefined): SnapshotSecurityVerdict | null {
  return row
    ? { malicious: row.malicious ?? 0, totalEngines: row.total_engines ?? null }
    : null;
}

/**
 * VirusTotal verdict for one installer payload, keyed by its SHA-256. The
 * primary source is catalog_file_reputation; the legacy qa_results VirusTotal
 * columns are the fallback (same status filter as the reputation lookup in
 * snapshot-source.ts) when the table or the row is absent.
 */
export function snapshotSecurityVerdictFromDb(
  db: DB,
  installerSha256: string
): SnapshotSecurityVerdict | null {
  const sha = installerSha256.trim().toLowerCase();
  if (!sha) return null;

  if (tableExists(db, 'catalog_file_reputation')) {
    const row = db
      .prepare('SELECT malicious, total_engines FROM catalog_file_reputation WHERE sha256 = ?')
      .get(sha) as
      | { malicious: number | null; total_engines: number | null }
      | undefined;
    if (row) return toVerdict(row);
  }

  if (tableExists(db, 'qa_results')) {
    // Legacy snapshots carry the scan on the QA row itself; only rows with a
    // completed VirusTotal scan count (same filter snapshot-source.ts uses).
    return toVerdict(
      db
        .prepare(
          `SELECT virustotal_malicious AS malicious, virustotal_total_engines AS total_engines
           FROM qa_results
           WHERE lower(installer_sha256) = ?
             AND virustotal_status IN ('clean', 'flagged', 'suspicious')
           ORDER BY virustotal_scanned_at_utc DESC
           LIMIT 1`
        )
        .get(sha) as
        | { malicious: number | null; total_engines: number | null }
        | undefined
    );
  }

  return null;
}

/**
 * Whether the snapshot holds a passed installation test for the exact
 * (winget id, version, architecture, installer sha) tuple, mirroring the
 * Supabase qa_package_results passed-row query in gate.ts. Installer hashes
 * are compared case-insensitively because both cases occur in the wild.
 */
export function snapshotHasPassedQaRowFromDb(
  db: DB,
  query: SnapshotQaEvidenceQuery
): boolean {
  const sha = query.installerSha256.trim();
  if (!sha) return false;
  if (!tableExists(db, 'qa_results')) return false;
  const row = db
    .prepare(
      `SELECT 1 FROM qa_results
       WHERE winget_id = ?
         AND tested_version = ?
         AND lower(architecture) = lower(?)
         AND lower(installer_sha256) = lower(?)
         AND outcome = 'Passed'
       LIMIT 1`
    )
    .get(query.wingetId, query.version, query.architecture, sha);
  return Boolean(row);
}

/** Run both gate lookups against an explicit snapshot handle. */
export function readSnapshotQaEvidenceFromDb(
  db: DB,
  query: SnapshotQaEvidenceQuery
): SnapshotQaEvidence {
  return {
    available: true,
    securityVerdict: snapshotSecurityVerdictFromDb(db, query.installerSha256),
    hasPassedRow: snapshotHasPassedQaRowFromDb(db, query),
  };
}

/**
 * Resolve the shared read-only snapshot handle and read the gate evidence
 * through it. An unavailable snapshot degrades to "no evidence" with one
 * warning line, mirroring how the Supabase path treats a missing row;
 * any other error still propagates.
 */
export async function readSnapshotQaEvidence(
  query: SnapshotQaEvidenceQuery
): Promise<SnapshotQaEvidence> {
  const { getSnapshotDb, SnapshotUnavailableError } = await import(
    '@/lib/catalog/snapshot-store'
  );
  let db: DB;
  try {
    db = await getSnapshotDb();
  } catch (err) {
    if (err instanceof SnapshotUnavailableError) {
      console.warn(
        '[qa-gate] Catalog snapshot unavailable; continuing without snapshot security and passed-QA evidence.'
      );
      return { available: false, securityVerdict: null, hasPassedRow: false };
    }
    throw err;
  }
  return readSnapshotQaEvidenceFromDb(db, query);
}
