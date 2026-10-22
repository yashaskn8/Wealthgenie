import { createHash } from 'node:crypto';

/**
 * Bind every qualified historical observation used for risk calibration.
 * Matching only the first/last ID and count misses corrected middle rows.
 * This fingerprint is an internal consistency check, not proof of a data license.
 */
export function fingerprintQualifiedHistory(rows) {
  if (!Array.isArray(rows) || rows.length > 1000) {
    throw new TypeError('Bounded historical observations are required');
  }
  const hash = createHash('sha256');
  for (const row of rows) {
    if (!row || typeof row !== 'object') {
      throw new TypeError('Historical observation must be a record');
    }
    const time = row.observed_at instanceof Date
      ? row.observed_at.toISOString() : row.observed_at;
    const serialized = JSON.stringify([
      row.id == null ? null : String(row.id),
      row.value == null ? null : String(row.value),
      time ?? null,
      row.source_id ?? null,
      row.source_instrument_id ?? null,
      row.source_revision ?? null,
      row.data_class ?? null,
    ]);
    hash.update(String(Buffer.byteLength(serialized)));
    hash.update(':');
    hash.update(serialized);
  }
  return hash.digest('hex');
}
