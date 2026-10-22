import 'dotenv/config';
import { Pool } from 'pg';
import { createFinancialPostgresPoolOptions } from '../postgres/poolConfig.js';

// Read-only release gate: coverage is measured, never invented or filled.
// Counts are source-qualifiable *candidates*, not personalized suitability.
if (!process.env.FINANCIAL_POSTGRES_URL) throw new Error('FINANCIAL_POSTGRES_URL_REQUIRED');
const pool = new Pool(createFinancialPostgresPoolOptions(process.env, { max: 1 }));
try {
  const { rows } = await pool.query([
    'SELECT f.id,f.name,c.label AS category,',
    'count(DISTINCT q.product_id) FILTER (WHERE',
    "q.status='ACTIVE' AND q.valid_until>now() AND q.reviewed_at<=now()",
    "AND p.record_kind='ACTUAL_PRODUCT' AND p.availability='AVAILABLE'",
    'AND p.recommendation_eligible=true',
    "AND p.qualified_tax_class NOT IN ('UNVERIFIED','OTHER_UNSUPPORTED')",
    'AND r.source_id=q.source_id AND r.access_allowed AND r.extraction_allowed',
    'AND r.storage_allowed AND r.derivation_allowed AND r.public_display_allowed',
    'AND r.commercial_use_allowed AND r.redistribution_allowed',
    'AND r.retention_seconds>0 AND r.reviewed_at IS NOT NULL',
    'AND r.revoked_at IS NULL AND (r.expires_at IS NULL OR r.expires_at>now())',
    'AND EXISTS (SELECT 1 FROM finance.market_observations o',
    'WHERE o.product_id=p.id AND o.source_id=q.source_id',
    'AND o.observation_type=q.observation_type',
    'AND o.retain_until>now() AND o.fetched_at<=now() AND o.observed_at<=now()',
    'AND (o.observation_type NOT IN (\'PRICE\',\'NAV\') OR o.value>0)',
    "AND (o.observation_type<>'NAV' OR o.data_class='END_OF_DAY')",
    "AND ((o.observation_type='PUBLISHED_RATE')=(o.data_class='PUBLISHED_RATE'))",
    'AND NOT EXISTS(SELECT 1 FROM finance.observation_corrections oc',
    'WHERE oc.observation_id=o.id)',
    'AND (',
    "(o.data_class='LIVE' AND o.observed_at>=now()-interval '5 minutes') OR",
    "(o.data_class='DELAYED' AND o.observed_at>=now()-interval '1 day') OR",
    "(o.data_class='END_OF_DAY' AND o.observed_at>=now()-interval '7 days') OR",
    "(o.data_class='PUBLISHED_RATE' AND",
    "o.effective_from<=(now() AT TIME ZONE 'Asia/Kolkata')::date AND",
    "(o.effective_to IS NULL OR o.effective_to>=(now() AT TIME ZONE 'Asia/Kolkata')::date))",
    ')) AS potentially_qualified',
    'FROM finance.products f',
    'JOIN finance.categories c ON c.id=f.category_id',
    'LEFT JOIN finance.family_product_qualifications q ON q.family_id=f.id',
    'LEFT JOIN finance.products p ON p.id=q.product_id',
    'LEFT JOIN finance.provider_rights r ON r.source_id=q.source_id',
    "WHERE f.record_kind='ARCHETYPE'",
    'GROUP BY f.id,f.name,c.label ORDER BY f.id',
  ].join(' '));
  if (rows.length < 250) throw new Error('FINANCIAL_FAMILY_COVERAGE_BELOW_250');
  const deficits = rows.map(row => ({
    familyId: row.id, name: row.name, category: row.category,
    potentialProducts: Number(row.potentially_qualified),
    slotsMissing: Math.max(0, 3 - Number(row.potentially_qualified)),
  }));
  const covered = deficits.filter(item => item.slotsMissing === 0);
  const summary = {
    status: 'EVIDENCE_MEASURED_NOT_INFERRED',
    at: new Date().toISOString(),
    families: rows.length,
    familiesWithThreePotentialProducts: covered.length,
    familiesWithFewerThanThree: deficits.length - covered.length,
    remainingTopThreeSlots: deficits.reduce((n,item) => n+item.slotsMissing, 0),
    topThreeIsMaximumNotQuota: true,
    qualifiedForAnySpecificInvestor: 'NOT_ASSESSED',
    missingOrUnderfilledFamilies: deficits.filter(item => item.slotsMissing>0),
  };
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
} finally {
  await pool.end();
}
