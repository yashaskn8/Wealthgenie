import { isIP } from 'node:net';

/**
 * Offline operator action. Confidential agreements never enter PostgreSQL:
 * only an opaque reference, SHA-256 digest, reviewed scopes and dates do.
 * This is not called from an HTTP route or inferred from public source access.
 */
const rights = [
  'access', 'extraction', 'storage', 'derivation', 'publicDisplay',
  'commercialUse', 'redistribution',
];
const bad = code => Object.assign(new Error(code), { code });
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9:_-]{1,160}$/.test(value);
const safeUrl = value => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password
      && url.hostname.includes('.') && !isIP(url.hostname)
      && ![...url.searchParams.keys()].some(key => /key|token|secret|password|credential/i.test(key))
      && value.length <= 2048;
  } catch { return false; }
};

export async function registerProviderRightsMetadata(pool, input, { now = new Date() } = {}) {
  if (!pool || typeof pool.connect !== 'function') throw bad('FINANCIAL_POSTGRES_REQUIRED');
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => ![
      'sourceId', 'endpointUrl', 'approvalReference', 'evidenceSha256',
      'attestedBy', 'reviewedAt', 'expiresAt', 'retentionSeconds', 'permissions',
    ].includes(key))) throw bad('RIGHTS_METADATA_INVALID');
  const { sourceId, endpointUrl, approvalReference, evidenceSha256, attestedBy,
    reviewedAt, expiresAt = null, retentionSeconds, permissions } = input;
  const reviewed = new Date(reviewedAt);
  const expiry = expiresAt === null ? null : new Date(expiresAt);
  if (!safeId(sourceId) || !safeUrl(endpointUrl)
    || typeof approvalReference !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/.test(approvalReference)
    || typeof evidenceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(evidenceSha256)
    || typeof attestedBy !== 'string' || attestedBy.trim().length < 3
    || attestedBy.length > 180 || /[\r\n\x00-\x1f]/.test(attestedBy)
    || typeof reviewedAt !== 'string' || !Number.isFinite(+now)
    || !Number.isFinite(+reviewed) || reviewed > now
    || (expiry !== null && (typeof expiresAt !== 'string'
      || !Number.isFinite(+expiry) || expiry <= now))
    || !Number.isSafeInteger(retentionSeconds) || retentionSeconds < 1
    || retentionSeconds > 10 * 365 * 24 * 60 * 60
    || !permissions || typeof permissions !== 'object' || Array.isArray(permissions)
    || Object.keys(permissions).length !== rights.length
    || rights.some(key => typeof permissions[key] !== 'boolean')) {
    throw bad('RIGHTS_METADATA_INVALID');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(
      'SELECT source_id FROM finance.provider_rights WHERE source_id=$1 FOR UPDATE', [sourceId],
    );
    if (existing.rows.length) throw bad('RIGHTS_RECORD_ALREADY_EXISTS_REVIEW_REQUIRED');
    await client.query(`
      INSERT INTO finance.provider_rights
        (source_id,endpoint_url,access_allowed,extraction_allowed,storage_allowed,
         derivation_allowed,public_display_allowed,commercial_use_allowed,
         redistribution_allowed,retention_seconds,evidence_url,evidence_sha256,
         approval_reference,attested_by,reviewed_at,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL,$11,$12,$13,$14,$15)`, [
      sourceId, endpointUrl, permissions.access, permissions.extraction,
      permissions.storage, permissions.derivation, permissions.publicDisplay,
      permissions.commercialUse, permissions.redistribution, retentionSeconds,
      evidenceSha256, approvalReference, attestedBy.trim(), reviewed, expiry,
    ]);
    await client.query('COMMIT');
    return { status: 'REGISTERED', sourceId, documentStored: false,
      endpointUrl, permissions: { ...permissions } };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
