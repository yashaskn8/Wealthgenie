import { verifyProviderEntitlement } from './verifyProviderEntitlement.js';

const bad = code => { const error = new Error(code); error.code = code; return error; };
const scopes = [
  'access','extraction','storage','derivation',
  'publicDisplay','commercialUse','redistribution',
];

/**
 * Apply only a cryptographically authenticated, independently anchored provider
 * receipt. The confidential agreement is never read or referenced.
 * Runs offline under a restricted operator identity; NEVER on user HTTP input.
 */
export async function applySignedProviderEntitlement(pool, receipt, anchors, {now=new Date()}={}) {
  const claim = verifyProviderEntitlement(receipt, anchors, {now});
  if (!pool || typeof pool.connect !== 'function') throw bad('FINANCIAL_POSTGRES_REQUIRED');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const {rows} = await client.query(
      'SELECT source_id,endpoint_url,revoked_at,verification_state,verification_revision,verification_issuer,verification_claim_id FROM finance.provider_rights WHERE source_id=$1 FOR UPDATE',
      [claim.sourceId],
    );
    const prior = rows[0];
    if (prior && (prior.revoked_at != null
      || prior.verification_state === 'REVOKED'
      || prior.verification_state === 'REJECTED'
      || (prior.verification_issuer && prior.verification_issuer !== claim.issuer)
      || (prior.verification_claim_id && prior.verification_claim_id !== claim.grantId)
      || (prior.endpoint_url && prior.endpoint_url !== claim.endpointUrl)
      || claim.revision <= Number(prior.verification_revision))) {
      throw bad('PROVIDER_PERMISSION_REPLAY_OR_TERMINAL');
    }
    if (claim.permissionState === 'REVOKED') {
      if (!prior) throw bad('PROVIDER_PERMISSION_UNKNOWN_SOURCE');
      await client.query(`
        UPDATE finance.provider_rights SET
          verification_state='REVOKED', revoked_at=$2, expires_at=$2,
          access_allowed=false,extraction_allowed=false,storage_allowed=false,
          derivation_allowed=false,public_display_allowed=false,
          commercial_use_allowed=false,redistribution_allowed=false,
          retention_seconds=0, verification_revision=$3,
          verification_claim_id=$4,verification_issuer=$5,
          verification_expires_at=$6,entitlement_receipt_sha256=$7
        WHERE source_id=$1`, [
        claim.sourceId,now,claim.revision,claim.grantId,claim.issuer,
        claim.expiresAt,claim.receiptSha256,
      ]);
    } else if (!prior) {
      await client.query(`
        INSERT INTO finance.provider_rights
          (source_id,endpoint_url,access_allowed,extraction_allowed,storage_allowed,
           derivation_allowed,public_display_allowed,commercial_use_allowed,
           redistribution_allowed,retention_seconds,evidence_url,
           reviewed_at,expires_at,verification_state,verification_issuer,
           verification_claim_id,verification_revision,verification_expires_at,
           entitlement_receipt_sha256)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL,$11,$12,'VERIFIED',
          $13,$14,$15,$16,$17)`, [
        claim.sourceId,claim.endpointUrl,...scopes.map(k=>claim.permissions[k]),
        claim.retentionSeconds,now,claim.expiresAt,claim.issuer,
        claim.grantId,claim.revision,claim.expiresAt,claim.receiptSha256,
      ]);
    } else {
      // A provider cannot silently change a source's endpoint under the same ID.
      // SQL updates are locked, versioned, and audited by existing triggers.
      const {rows: current} = await client.query(
        'SELECT endpoint_url FROM finance.provider_rights WHERE source_id=$1', [claim.sourceId]);
      if (current.length!==1 || current[0].endpoint_url!==claim.endpointUrl)
        throw bad('PROVIDER_PERMISSION_ENDPOINT_MISMATCH');
      await client.query(`
        UPDATE finance.provider_rights SET
          access_allowed=$2,extraction_allowed=$3,storage_allowed=$4,
          derivation_allowed=$5,public_display_allowed=$6,
          commercial_use_allowed=$7,redistribution_allowed=$8,
          retention_seconds=$9,reviewed_at=$10,expires_at=$11,
          revoked_at=NULL,verification_state='VERIFIED',
          verification_issuer=$12,verification_claim_id=$13,
          verification_revision=$14,verification_expires_at=$15,
          entitlement_receipt_sha256=$16
        WHERE source_id=$1`,[
        claim.sourceId,...scopes.map(k=>claim.permissions[k]),
        claim.retentionSeconds,now,claim.expiresAt,claim.issuer,
        claim.grantId,claim.revision,claim.expiresAt,claim.receiptSha256,
      ]);
    }
    // Immutable ledger is written in the SAME transaction as the rights update.
    // A reused old receipt, grant revision or receipt digest cannot be accepted.
    await client.query(
      'INSERT INTO finance.provider_entitlement_receipts ' +
      '(issuer,grant_id,revision,source_id,receipt_sha256,result_state) ' +
      'VALUES ($1,$2,$3,$4,$5,$6)',
      [claim.issuer,claim.grantId,claim.revision,claim.sourceId,
        claim.receiptSha256,claim.permissionState],
    );
    await client.query('COMMIT');
    return {
      sourceId:claim.sourceId,status:claim.permissionState,
      providerIssuer:claim.issuer,verificationRevision:claim.revision,
      expiresAt:claim.expiresAt,documentAccessed:false,
    };
  } catch(error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {client.release();}
}
