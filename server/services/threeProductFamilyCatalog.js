
/** Source-backed family candidate discovery. No issuer or data rights are invented. */
export async function listFamiliesWithThreeSourceQualifiedProducts(pool,now=new Date()){
 if(!pool||typeof pool.query!=='function')throw new TypeError('FINANCIAL_POSTGRES_REQUIRED');
 if(!(now instanceof Date)||!Number.isFinite(+now))throw new TypeError('INVALID_COMPARISON_TIME');
 const sql=[
 "SELECT f.id AS family_id,count(DISTINCT p.source_identity)::integer AS product_count",
 "FROM finance.products f",
 "JOIN finance.family_product_qualifications q ON q.family_id=f.id",
 "JOIN finance.products p ON p.id=q.product_id",
 "JOIN finance.provider_rights r ON r.source_id=q.source_id",
 "WHERE f.record_kind='ARCHETYPE' AND q.status='ACTIVE' AND q.reviewed_at<=$1 AND q.valid_until>$1",
 "AND p.record_kind='ACTUAL_PRODUCT' AND p.availability='AVAILABLE'",
 "AND p.recommendation_eligible=true AND p.category_id=f.category_id",
 "AND p.verification_scope='VERIFIED_ACTUAL_PRODUCT' AND p.source_identity IS NOT NULL",
 "AND p.qualified_tax_class NOT IN ('UNVERIFIED','OTHER_UNSUPPORTED')",
 "AND p.tax_class_evidence_url LIKE 'https://%' AND p.tax_class_reviewed_at IS NOT NULL",
 "AND p.tax_class_reviewed_at<=$1",
 "AND q.retail_access=true AND q.requires_demat=false AND q.requires_accreditation=false",
 "AND q.requires_nps_account=false AND q.requires_child_eligibility=false",
 "AND r.access_allowed AND r.extraction_allowed AND r.storage_allowed",
 "AND r.derivation_allowed AND r.public_display_allowed AND r.commercial_use_allowed",
 "AND r.redistribution_allowed AND r.retention_seconds>0 AND r.reviewed_at IS NOT NULL",
 "AND r.reviewed_at<=$1 AND r.revoked_at IS NULL",
 "AND r.verification_state='VERIFIED' AND r.verification_expires_at>$1",
 "AND (r.expires_at IS NULL OR r.expires_at>$1)",
 "AND EXISTS (SELECT 1 FROM finance.market_observations o",
 "JOIN finance.product_external_ids ext ON ext.product_id=p.id",
 "AND ext.source_id=q.source_id AND ext.source_instrument_id=o.source_instrument_id",
 "WHERE o.product_id=p.id AND o.source_id=q.source_id",
 "AND o.observation_type=q.observation_type AND o.retain_until IS NOT NULL",
 "AND o.retain_until>$1 AND o.observed_at<=$1 AND o.fetched_at<=$1",
 "AND (o.observation_type NOT IN ('PRICE','NAV') OR o.value>0)",
 "AND (o.observation_type<>'NAV' OR o.data_class='END_OF_DAY')",
 "AND ((o.observation_type='PUBLISHED_RATE')=(o.data_class='PUBLISHED_RATE'))",
 "AND (CASE o.data_class",
 "WHEN 'LIVE' THEN o.observed_at >= $1::timestamptz - interval '5 minutes'",
 "WHEN 'DELAYED' THEN o.observed_at >= $1::timestamptz - interval '1 day'",
 "WHEN 'END_OF_DAY' THEN o.observed_at >= $1::timestamptz - interval '7 days'",
 "WHEN 'PUBLISHED_RATE' THEN o.effective_from <= ($1::timestamptz AT TIME ZONE 'Asia/Kolkata')::date",
 "AND (o.effective_to IS NULL OR o.effective_to >= ($1::timestamptz AT TIME ZONE 'Asia/Kolkata')::date)",
 "ELSE false END)",
 "AND NOT EXISTS(SELECT 1 FROM finance.observation_corrections oc WHERE oc.observation_id=o.id))",
 "GROUP BY f.id",
 "HAVING count(DISTINCT p.source_identity)>=2 ORDER BY f.id LIMIT 251"
 ].join(' ');
 const {rows}=await pool.query(sql,[now]);
 if(!Array.isArray(rows)||rows.length>250)throw new Error('QUALIFIED_FAMILY_RESULT_INVALID');
 const seen=new Set();
 for(const row of rows){
  if(typeof row.family_id!=='string'||!/^[a-zA-Z0-9:_-]{1,160}$/.test(row.family_id)
    ||!Number.isSafeInteger(row.product_count)||row.product_count<2||seen.has(row.family_id)){
   throw new Error('QUALIFIED_FAMILY_RESULT_INVALID');
  }
  seen.add(row.family_id);
 }
 return {status:'TWO_OR_MORE_SOURCE_QUALIFIED_CANDIDATES',minimumProducts:2,maxResults:3,
  familyIds:[...seen],count:seen.size,asOf:now.toISOString(),personalizedSuitabilityVerified:false,
  disclosure:'Candidates only; profile-specific suitability must be rechecked at comparison time.'};
}
