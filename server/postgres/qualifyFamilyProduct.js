/**
 * Offline-only audited actual-product qualification; never called from HTTP.
 * Product identity, provider rights, and tax class are independently verified
 * in PostgreSQL. A discovery category URL alone cannot approve a product.
 */
const error = code => { const e = new Error(code); e.code = code; return e; };
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9:_-]{1,160}$/.test(value);
const httpsUrl = value => {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password; }
  catch { return false; }
};
const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const number = (value, min, max) => typeof value === 'number' && Number.isFinite(value)
  && value >= min && value <= max;

export async function qualifyProductForFamily(pool, input, { now = new Date() } = {}) {
  if (!pool || typeof pool.connect !== 'function') throw error('FINANCIAL_POSTGRES_REQUIRED');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw error('FAMILY_REVIEW_INVALID');
  const {
    familyId, productId, sourceId, observationType, evidenceUrl, termsEvidenceUrl,
    riskEvidenceUrl, reviewedBy, reviewedAt, validUntil, riskLevel, minInvestmentInr,
    minHorizonYears, lockInMonths, annualFeeBps, minAge = 18, maxAge = 120,
    retailAccess = false, requiresDemat = false, requiresAccreditation = false,
    requiresNpsAccount = false, requiresChildEligibility = false, reviewNote,
  } = input;
  const [review, expiry] = [new Date(reviewedAt), new Date(validUntil)];
  if (!validId(familyId) || !validId(productId) || !validId(sourceId)
    || familyId === productId || !['PRICE', 'NAV', 'PUBLISHED_RATE', 'YIELD'].includes(observationType)
    || ![evidenceUrl, termsEvidenceUrl, riskEvidenceUrl].every(httpsUrl)
    || typeof reviewedBy !== 'string' || reviewedBy.trim().length < 3 || reviewedBy.length > 180
    || typeof reviewNote !== 'string' || reviewNote.trim().length < 12 || reviewNote.length > 1500
    || !Number.isFinite(+review) || !Number.isFinite(+expiry)
    || !Number.isFinite(+now) || review > now || expiry <= now || expiry <= review
    || !integer(riskLevel, 1, 5) || !number(minInvestmentInr, 0.01, 1e15)
    || !integer(minHorizonYears, 0, 40) || !integer(lockInMonths, 0, 480)
    || !integer(annualFeeBps, 0, 10000) || !integer(minAge, 0, 120)
    || !integer(maxAge, minAge, 120)
    || [retailAccess, requiresDemat, requiresAccreditation, requiresNpsAccount,
      requiresChildEligibility].some(value => typeof value !== 'boolean')) {
    throw error('FAMILY_REVIEW_INVALID');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query([
      'SELECT f.id AS family_id, c.label AS category,p.id AS product_id',
      'FROM finance.products f JOIN finance.categories c ON c.id=f.category_id',
      'JOIN finance.products p ON p.id=$2',
      'JOIN finance.product_external_ids ext ON ext.product_id=p.id AND ext.source_id=$3',
      'JOIN finance.provider_rights r ON r.source_id=ext.source_id',
      "WHERE f.id=$1 AND f.record_kind='ARCHETYPE' AND p.record_kind='ACTUAL_PRODUCT'",
      "AND p.category_id=f.category_id AND p.availability='AVAILABLE'",
      "AND p.verification_scope='VERIFIED_ACTUAL_PRODUCT'",
      "AND p.qualified_tax_class NOT IN ('UNVERIFIED','OTHER_UNSUPPORTED')",
      "AND p.tax_class_evidence_url LIKE 'https://%'",
      'AND p.tax_class_reviewed_at IS NOT NULL AND p.tax_class_reviewed_at<=now()',
      'AND r.access_allowed AND r.extraction_allowed AND r.storage_allowed',
      'AND r.derivation_allowed AND r.public_display_allowed',
      'AND r.commercial_use_allowed AND r.redistribution_allowed',
      'AND r.retention_seconds>0 AND r.reviewed_at IS NOT NULL',
      'AND r.reviewed_at<=now() AND r.revoked_at IS NULL',
      "AND r.verification_state='VERIFIED' AND r.verification_expires_at>now()", 
      'AND (r.expires_at IS NULL OR r.expires_at>now())',
      'FOR SHARE OF f,p,r',
    ].join(' '), [familyId, productId, sourceId]);
    if (found.rows.length !== 1) throw error('ACTUAL_PRODUCT_OR_RIGHTS_NOT_QUALIFIED');
    if (found.rows[0].category === 'Regulated Alternatives' && retailAccess) {
      throw error('RESTRICTED_PRODUCT_REQUIRES_SEPARATE_ELIGIBILITY_POLICY');
    }
    const prior = await client.query([
      'SELECT status FROM finance.family_product_qualifications',
      'WHERE family_id=$1 AND product_id=$2 FOR UPDATE',
    ].join(' '), [familyId, productId]);
    if (prior.rows.length && prior.rows[0].status === 'ACTIVE') {
      throw error('ACTIVE_FAMILY_REVIEW_REQUIRES_EXPLICIT_SUSPENSION');
    }
    await client.query([
      'INSERT INTO finance.family_product_qualifications',
      '(family_id,product_id,source_id,observation_type,status,evidence_url,terms_evidence_url,',
      'risk_evidence_url,reviewed_by,reviewed_at,valid_until,risk_level,min_investment_inr,',
      'min_horizon_years,lock_in_months,annual_fee_bps,min_age,max_age,retail_access,',
      'requires_demat,requires_accreditation,requires_nps_account,requires_child_eligibility,',
      'last_review_note)',
      "VALUES ($1,$2,$3,$4,'ACTIVE',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,",
      '$16,$17,$18,$19,$20,$21,$22,$23)',
      'ON CONFLICT (family_id,product_id) DO UPDATE SET',
      'source_id=EXCLUDED.source_id,observation_type=EXCLUDED.observation_type,',
      "status='ACTIVE',evidence_url=EXCLUDED.evidence_url,",
      'terms_evidence_url=EXCLUDED.terms_evidence_url,',
      'risk_evidence_url=EXCLUDED.risk_evidence_url,',
      'reviewed_by=EXCLUDED.reviewed_by,reviewed_at=EXCLUDED.reviewed_at,',
      'valid_until=EXCLUDED.valid_until,risk_level=EXCLUDED.risk_level,',
      'min_investment_inr=EXCLUDED.min_investment_inr,',
      'min_horizon_years=EXCLUDED.min_horizon_years,lock_in_months=EXCLUDED.lock_in_months,',
      'annual_fee_bps=EXCLUDED.annual_fee_bps,min_age=EXCLUDED.min_age,',
      'max_age=EXCLUDED.max_age,retail_access=EXCLUDED.retail_access,',
      'requires_demat=EXCLUDED.requires_demat,',
      'requires_accreditation=EXCLUDED.requires_accreditation,',
      'requires_nps_account=EXCLUDED.requires_nps_account,',
      'requires_child_eligibility=EXCLUDED.requires_child_eligibility,',
      'last_review_note=EXCLUDED.last_review_note,',
      'review_version=finance.family_product_qualifications.review_version+1',
    ].join(' '), [
      familyId, productId, sourceId, observationType, evidenceUrl, termsEvidenceUrl,
      riskEvidenceUrl, reviewedBy.trim(), review, expiry, riskLevel,
      minInvestmentInr, minHorizonYears, lockInMonths, annualFeeBps, minAge, maxAge,
      retailAccess, requiresDemat, requiresAccreditation, requiresNpsAccount,
      requiresChildEligibility, reviewNote.trim(),
    ]);
    await client.query([
      'UPDATE finance.products SET recommendation_eligible=true,version=version+1',
      "WHERE id=$1 AND record_kind='ACTUAL_PRODUCT' AND availability='AVAILABLE'",
    ].join(' '), [productId]);
    await client.query('COMMIT');
    return { status: 'ACTIVE', familyId, productId, comparisonAllowedOnlyAfterRuntimeChecks: true };
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}

export async function suspendProductForFamily(pool, { familyId, productId, reviewedBy, reviewNote } = {}) {
  if (!pool || typeof pool.connect !== 'function' || !validId(familyId) || !validId(productId)
    || typeof reviewedBy !== 'string' || reviewedBy.trim().length < 3
    || typeof reviewNote !== 'string' || reviewNote.trim().length < 12) {
    throw error('FAMILY_SUSPENSION_INVALID');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query([
      'UPDATE finance.family_product_qualifications',
      "SET status='SUSPENDED',reviewed_by=$3,last_review_note=$4,review_version=review_version+1",
      "WHERE family_id=$1 AND product_id=$2 AND status='ACTIVE' RETURNING product_id",
    ].join(' '), [familyId, productId, reviewedBy.trim(), reviewNote.trim()]);
    if (result.rows.length !== 1) throw error('FAMILY_QUALIFICATION_NOT_ACTIVE');
    await client.query('COMMIT');
    return { status: 'SUSPENDED', familyId, productId };
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}
