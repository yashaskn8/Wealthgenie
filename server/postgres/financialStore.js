/**
 * Financial reference-data authority. The pool must implement node-postgres
 * query/connect; this adapter intentionally never owns MongoDB investor state.
 * Publication and storage require separately verified rights.
 */
export function createFinancialStore(pool, {env = process.env} = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('A PostgreSQL pool with query and connect is required');
  }
  async function transaction(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  function assertIdentity(id) {
    if (typeof id !== 'string' || id.length < 1 || id.length > 160
        || !/^[a-zA-Z0-9:_-]+$/.test(id)) {
      throw new TypeError('Canonical financial product ID is invalid');
    }
    return id;
  }
  async function browse({ category = null, subcategory = null, cursor = null, limit = 20 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RangeError('Invalid page size');
    for (const field of [category, subcategory, cursor]) {
      if (field !== null && (typeof field !== 'string' || field.length > 160 || /[\x00-\x1f\x7f]/.test(field))) {
        throw new TypeError('Invalid catalog filter');
      }
    }
    const { rows } = await pool.query(
      `SELECT p.id,p.name,p.record_kind,p.availability,p.recommendation_eligible,
              p.discovery_reference_url,p.verification_scope,p.assessed_as_of,
              p.discovery_metadata,
              c.id AS category_id,c.label AS category,
              s.id AS subcategory_id,s.label AS subcategory
         FROM finance.products p JOIN finance.categories c ON p.category_id=c.id
         LEFT JOIN finance.subcategories s ON p.subcategory_id=s.id
        WHERE ($1::text IS NULL OR c.id=$1)
          AND ($2::text IS NULL OR s.id=$2)
          AND ($3::text IS NULL OR p.id>$3)
        ORDER BY p.id LIMIT $4`,
      [category, subcategory, cursor, limit + 1],
    );
    return { items: rows.slice(0, limit), nextCursor: rows.length > limit ? rows[limit - 1].id : null };
  }
  async function summary() {
    const { rows } = await pool.query(`
      SELECT count(*)::integer AS "totalCount",
        count(*) FILTER (WHERE record_kind='ARCHETYPE')::integer AS "discoveryFamilies",
        count(*) FILTER (WHERE record_kind='ACTUAL_PRODUCT')::integer AS "actualProducts",
        count(*) FILTER (WHERE availability='AVAILABLE')::integer AS "availableRecords",
        count(*) FILTER (WHERE availability='UNVERIFIED')::integer AS "unverifiedRecords",
        count(*) FILTER (WHERE recommendation_eligible IS TRUE)::integer AS "qualificationFlagged"
      FROM finance.products`);
    if (!rows[0] || !Number.isSafeInteger(rows[0].totalCount)) {
      throw new Error('FINANCIAL_CATALOG_SUMMARY_INVALID');
    }
    return rows[0];
  }
  async function latestPublishableObservation(productId, kind, now = new Date(), sourceId = null) {
    assertIdentity(productId);
    if (!['PRICE','NAV','PUBLISHED_RATE','YIELD','VOLUME'].includes(kind)) throw new TypeError('Invalid market observation type');
    if (sourceId !== null && (typeof sourceId !== 'string' || !/^[a-zA-Z0-9:_-]{1,160}$/.test(sourceId))) {
      throw new TypeError('Exact provider source ID invalid');
    }
    const { rows } = await pool.query(
      `SELECT o.id,o.product_id,o.observation_type,o.value::text AS value,o.currency,
              o.unit,o.data_class,o.effective_from,o.effective_to,o.observed_at,o.fetched_at,o.source_id,
              o.source_instrument_id,
              o.retain_until,r.expires_at AS rights_expire_at
         FROM finance.market_observations o
         JOIN finance.provider_rights r ON r.source_id=o.source_id
         JOIN finance.products p ON p.id=o.product_id
        WHERE o.product_id=$1 AND o.observation_type=$2
          AND ($4::text IS NULL OR o.source_id=$4)
          AND p.record_kind='ACTUAL_PRODUCT' AND p.availability IN ('AVAILABLE','RESTRICTED')
          AND (o.observation_type NOT IN ('PRICE','NAV') OR o.value>0)
          AND (o.observation_type<>'NAV' OR o.data_class='END_OF_DAY')
          AND ((o.observation_type='PUBLISHED_RATE') = (o.data_class='PUBLISHED_RATE'))
          AND r.access_allowed AND r.extraction_allowed AND r.storage_allowed
          AND r.derivation_allowed AND r.public_display_allowed
          AND r.commercial_use_allowed AND r.redistribution_allowed
          AND r.reviewed_at IS NOT NULL AND r.revoked_at IS NULL
          AND (r.expires_at IS NULL OR r.expires_at>$3)
          AND o.retain_until IS NOT NULL AND o.retain_until>$3
          AND o.observed_at<=$3 AND o.fetched_at<=$3
          AND (CASE o.data_class
                WHEN 'LIVE' THEN o.observed_at >= $3::timestamptz - interval '5 minutes'
                WHEN 'DELAYED' THEN o.observed_at >= $3::timestamptz - interval '1 day'
                WHEN 'END_OF_DAY' THEN o.observed_at >= $3::timestamptz - interval '7 days'
                WHEN 'PUBLISHED_RATE' THEN o.effective_from <= ($3::timestamptz AT TIME ZONE 'Asia/Kolkata')::date
                  AND (o.effective_to IS NULL OR o.effective_to >= ($3::timestamptz AT TIME ZONE 'Asia/Kolkata')::date)
                ELSE false END)
          AND NOT EXISTS (
            SELECT 1 FROM finance.observation_corrections oc WHERE oc.observation_id=o.id
          )
        ORDER BY o.observed_at DESC,o.id DESC LIMIT 1`,
      [productId, kind, now, sourceId],
    );
    return rows[0] || null;
  }
  /**
   * Strictly one verified source and instrument. Historical source prices are
   * NOT automatically investable, adjusted total returns, or forecasts.
   * Only retained end-of-day price/NAV observations with full licensed
   * analytical rights may leave this adapter.
   */
  async function qualifiedHistoricalPrices(productId, kind, sourceId, now = new Date()) {
    assertIdentity(productId);
    if (!['PRICE', 'NAV'].includes(kind)) throw new TypeError('Historical metric must be PRICE or NAV');
    if (typeof sourceId !== 'string' || !/^[a-zA-Z0-9:_-]{1,160}$/.test(sourceId))
      throw new TypeError('Exact market source ID is required');
    if (!(now instanceof Date) || !Number.isFinite(+now)) throw new TypeError('Valid valuation time required');
    const { rows } = await pool.query(`
      SELECT o.id,o.value::text AS value,o.observed_at,o.source_id,
             o.source_instrument_id,o.source_revision,o.data_class
        FROM finance.market_observations o
        JOIN finance.provider_rights r ON r.source_id=o.source_id
        JOIN finance.products p ON p.id=o.product_id
       WHERE o.product_id=$1 AND o.observation_type=$2 AND o.source_id=$3
         AND p.record_kind='ACTUAL_PRODUCT'
         AND p.qualified_tax_class='LISTED_EQUITY_STT_QUALIFIED'
         AND p.tax_class_evidence_url LIKE 'https://%'
         AND p.tax_class_reviewed_at IS NOT NULL
         AND p.availability IN ('AVAILABLE','RESTRICTED')
         AND r.access_allowed AND r.extraction_allowed AND r.storage_allowed
         AND r.derivation_allowed AND r.public_display_allowed
         AND r.commercial_use_allowed AND r.redistribution_allowed
         AND r.reviewed_at IS NOT NULL AND r.revoked_at IS NULL
         AND (r.expires_at IS NULL OR r.expires_at>$4)
         AND o.retain_until IS NOT NULL AND o.retain_until>$4
         AND o.observed_at<=$4 AND o.fetched_at<=$4
         AND o.observed_at>=$4::timestamptz-interval '4 years'
         AND o.value>0 AND o.data_class='END_OF_DAY'
         AND NOT EXISTS (SELECT 1 FROM finance.observation_corrections c WHERE c.observation_id=o.id)
       ORDER BY o.observed_at DESC,o.id DESC LIMIT 1000`,
      [productId, kind, sourceId, now],
    );
    return rows;
  }
  async function appendObservation(input) {
    if (!input || typeof input !== 'object') throw new TypeError('Financial observation is required');
    assertIdentity(input.productId);
    if (!['PRICE','NAV','PUBLISHED_RATE','YIELD','VOLUME'].includes(input.kind)) throw new TypeError('Unknown observation type');
    if (!['LIVE','DELAYED','END_OF_DAY','PUBLISHED_RATE'].includes(input.dataClass)) throw new TypeError('Unknown observation data class');
    if (typeof input.value !== 'string' || !/^(0|[1-9][0-9]*)(\.[0-9]{1,8})?$/.test(input.value)) {
      throw new TypeError('Observation value must be an exact non-negative decimal string');
    }
    if (['PRICE','NAV'].includes(input.kind)
      && (!Number.isFinite(Number(input.value)) || Number(input.value)<=0)) {
      throw new TypeError('Market prices and NAVs must be strictly positive');
    }
    if (input.kind==='NAV' && input.dataClass!=='END_OF_DAY') {
      throw new TypeError('Mutual fund NAV requires an end-of-day observation');
    }
    if ((input.kind==='PUBLISHED_RATE') !== (input.dataClass==='PUBLISHED_RATE')) {
      throw new TypeError('Published rate metric and observation class must match');
    }
    if (typeof input.sourceId !== 'string' || !input.sourceId.trim()) throw new TypeError('Source identity required');
    if (typeof input.sourceInstrumentId !== 'string' || input.sourceInstrumentId.length < 1
      || input.sourceInstrumentId.length > 255 || /[\x00-\x1f\x7f]/.test(input.sourceInstrumentId)) {
      throw new TypeError('Exact source instrument identity required');
    }
    if (typeof input.unit !== 'string' || input.unit.length < 1 || input.unit.length > 40
        || /[\x00-\x1f\x7f]/.test(input.unit)) throw new TypeError('Invalid unit');
    if (['PRICE','NAV'].includes(input.kind)
      && (input.currency !== 'INR' || input.unit !== 'INR_PER_UNIT')) {
      throw new TypeError('Market prices/NAV require exact INR per unit identity');
    }
    if (input.kind === 'PUBLISHED_RATE'
      && (input.dataClass !== 'PUBLISHED_RATE' || input.unit !== 'PERCENT_PER_ANNUM')) {
      throw new TypeError('Published interest rates require correct rate units and data class');
    }
    if (input.dataClass === 'PUBLISHED_RATE'
      && (typeof input.effectiveFrom !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(input.effectiveFrom))) {
      throw new TypeError('Published rates require a verified effective-from date');
    }
    if (input.effectiveTo != null && (typeof input.effectiveTo !== 'string'
      || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(input.effectiveTo)
      || (input.effectiveFrom && input.effectiveTo < input.effectiveFrom))) {
      throw new TypeError('Invalid rate effective-to date');
    }
    const observed = new Date(input.observedAt), fetched = new Date(input.fetchedAt);
    if (!Number.isFinite(+observed) || !Number.isFinite(+fetched) || fetched < observed || fetched > new Date()) {
      throw new TypeError('Invalid observation timestamps');
    }
    return transaction(async client => {
      const product = await client.query(
        'SELECT id,record_kind,availability FROM finance.products WHERE id=$1 FOR SHARE',
        [input.productId],
      );
      if (product.rows[0]?.record_kind !== 'ACTUAL_PRODUCT'
          || !['AVAILABLE','RESTRICTED'].includes(product.rows[0].availability)) {
        const error = new Error('ACTUAL_INVESTMENT_PRODUCT_NOT_QUALIFIED');
        error.code = 'ACTUAL_INVESTMENT_PRODUCT_NOT_QUALIFIED';
        throw error;
      }
      const identity = await client.query(
        `SELECT product_id FROM finance.product_external_ids
         WHERE product_id=$1 AND source_id=$2 AND source_instrument_id=$3 FOR SHARE`,
        [input.productId,input.sourceId,input.sourceInstrumentId],
      );
      if (identity.rows.length !== 1) {
        const error = new Error('PRODUCT_PROVIDER_IDENTITY_MISMATCH');
        error.code = 'PRODUCT_PROVIDER_IDENTITY_MISMATCH';
        throw error;
      }
      const rights = await client.query(
        `SELECT source_id,retention_seconds FROM finance.provider_rights
          WHERE source_id=$1 AND access_allowed AND extraction_allowed AND storage_allowed
            AND derivation_allowed AND commercial_use_allowed
            AND reviewed_at IS NOT NULL AND revoked_at IS NULL
            AND (expires_at IS NULL OR expires_at>now()) FOR SHARE`,
        [input.sourceId],
      );
      if (rights.rows.length !== 1) {
        const error = new Error('MARKET_DATA_SOURCE_RIGHTS_UNQUALIFIED');
        error.code = 'MARKET_DATA_SOURCE_RIGHTS_UNQUALIFIED';
        throw error;
      }
      const seconds = rights.rows[0].retention_seconds;
      // Unspecified retention is not unlimited: require an explicit approved policy.
      if (seconds === null || seconds === undefined) throw new Error('MARKET_DATA_RETENTION_UNVERIFIED');
      const retainedUntil = new Date(+fetched + Number(seconds) * 1000);
      if (!Number.isFinite(+retainedUntil) || retainedUntil <= new Date()) {
        throw new Error('MARKET_DATA_RETENTION_EXPIRED');
      }
      // Supabase Free has a 500 MB database ceiling. Preserve headroom for
      // indexes, migrations and catalog metadata; never attempt a write when
      // the explicit trial budget is exhausted. This is not a paid-data license.
      if (env.FINANCIAL_POSTGRES_TRIAL_MODE === 'true') {
        const maxBytes = env.FINANCIAL_POSTGRES_MAX_BYTES === undefined
          ? 350_000_000 : Number(env.FINANCIAL_POSTGRES_MAX_BYTES);
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 10_000_000 || maxBytes > 450_000_000) {
          throw new RangeError('FINANCIAL_POSTGRES_MAX_BYTES must be 10000000-450000000');
        }
        const usage = await client.query(
          'SELECT pg_database_size(current_database())::bigint AS bytes',
        );
        if (BigInt(usage.rows[0]?.bytes ?? -1) < 0n
          || BigInt(usage.rows[0].bytes) >= BigInt(maxBytes)) {
          const error = new Error('FINANCIAL_TRIAL_DATABASE_BUDGET_EXCEEDED');
          error.code = 'FINANCIAL_TRIAL_DATABASE_BUDGET_EXCEEDED';
          throw error;
        }
      }
      const result = await client.query(
        `INSERT INTO finance.market_observations
          (product_id,source_id,source_instrument_id,observation_type,value,currency,unit,data_class,
           observed_at,fetched_at,source_revision,retain_until,effective_from,effective_to)
         VALUES ($1,$2,$3,$4,$5::numeric,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (product_id,source_id,source_instrument_id,observation_type,observed_at,source_revision)
         DO NOTHING RETURNING id`,
        [input.productId,input.sourceId,input.sourceInstrumentId,input.kind,input.value,input.currency || null,
          input.unit,input.dataClass,observed,fetched,input.sourceRevision || '0',retainedUntil,
          input.effectiveFrom || null,input.effectiveTo || null],
      );
      return { stored: result.rowCount === 1, observationId: result.rows[0]?.id || null };
    });
  }
  return { browse, summary, latestPublishableObservation, qualifiedHistoricalPrices, appendObservation, transaction };
}
