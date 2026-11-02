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
  /** A completed scan with engine coverage and no malicious or suspicious hits. */
  coveredClean: boolean;
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

interface VerdictRow {
  completed: number;
  malicious: number | null;
  suspicious: number | null;
  total_engines: number | null;
}

function toVerdict(row: VerdictRow | undefined): SnapshotSecurityVerdict | null {
  if (!row) return null;
  const totalEngines = row.total_engines ?? null;
  return {
    malicious: row.malicious ?? 0,
    totalEngines,
    coveredClean: row.completed === 1 && row.malicious === 0 && row.suspicious === 0 &&
      Number.isInteger(totalEngines) && (totalEngines as number) > 0,
  };
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
      .prepare(
        `SELECT status = 'found' AS completed, malicious, suspicious, total_engines
         FROM catalog_file_reputation WHERE sha256 = ?`
      )
      .get(sha) as VerdictRow | undefined;
    if (row) return toVerdict(row);
  }

  if (tableExists(db, 'qa_results')) {
    // Legacy snapshots carry the scan on the QA row itself; only rows with a
    // completed VirusTotal scan count (same filter snapshot-source.ts uses).
    return toVerdict(
      db
        .prepare(
          `SELECT virustotal_status = 'clean' AS completed, virustotal_malicious AS malicious,
                  virustotal_suspicious AS suspicious, virustotal_total_engines AS total_engines
           FROM qa_results
           WHERE lower(installer_sha256) = ?
             AND virustotal_status IN ('clean', 'flagged', 'suspicious')
           ORDER BY virustotal_scanned_at_utc DESC
           LIMIT 1`
        )
        .get(sha) as VerdictRow | undefined
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

const SHA256_HEX = /^[a-f0-9]{64}$/;

/**
 * SQLite-mode counterpart of arePackageDependenciesCovered: every dependency
 * installer must have a covered clean verdict in the snapshot. The snapshot
 * carries no freshness columns (checked_at, retry_after, engine_count_version)
 * and no installer security holds, so this is the snapshot's best available
 * evidence, not the hosted seven-day contract. Fails closed on bad input.
 */
export function snapshotDependenciesCoveredFromDb(
  db: DB,
  dependencies: readonly { installerSha256: string }[]
): boolean {
  if (!dependencies.length) return true;
  if (dependencies.length > 8) return false;
  const hashes = dependencies.map(dependency => dependency.installerSha256.trim().toLowerCase());
  if (hashes.some(hash => !SHA256_HEX.test(hash) || hash === '0'.repeat(64))) return false;
  return [...new Set(hashes)].every(hash => snapshotSecurityVerdictFromDb(db, hash)?.coveredClean === true);
}

/** Resolve the shared snapshot handle; an unavailable snapshot fails closed. */
export async function readSnapshotDependenciesCovered(
  dependencies: readonly { installerSha256: string }[]
): Promise<boolean> {
  if (!dependencies.length) return true;
  const { getSnapshotDb, SnapshotUnavailableError } = await import(
    '@/lib/catalog/snapshot-store'
  );
  try {
    return snapshotDependenciesCoveredFromDb(await getSnapshotDb(), dependencies);
  } catch (err) {
    if (err instanceof SnapshotUnavailableError) return false;
    throw err;
  }
}
