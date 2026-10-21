/**
 * Financial reference-data authority. The pool must implement node-postgres
 * query/connect; this adapter intentionally never owns MongoDB investor state.
 * Publication and storage require separately verified rights.
 */
export function createFinancialStore(pool) {
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
    if (typeof id !== 'string' || id.length < 3 || id.length > 160
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
  async function latestPublishableObservation(productId, kind, now = new Date()) {
    assertIdentity(productId);
    if (!['PRICE','NAV','PUBLISHED_RATE','YIELD','VOLUME'].includes(kind)) throw new TypeError('Invalid market observation type');
    const { rows } = await pool.query(
      `SELECT o.id,o.product_id,o.observation_type,o.value::text AS value,o.currency,
              o.unit,o.data_class,o.effective_from,o.effective_to,o.observed_at,o.fetched_at,o.source_id,
              o.retain_until,r.expires_at AS rights_expire_at
         FROM finance.market_observations o
         JOIN finance.provider_rights r ON r.source_id=o.source_id
         JOIN finance.products p ON p.id=o.product_id
        WHERE o.product_id=$1 AND o.observation_type=$2
          AND p.record_kind='ACTUAL_PRODUCT' AND p.availability IN ('AVAILABLE','RESTRICTED')
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
      [productId, kind, now],
    );
    return rows[0] || null;
  }
  async function appendObservation(input) {
    if (!input || typeof input !== 'object') throw new TypeError('Financial observation is required');
    assertIdentity(input.productId);
    if (!['PRICE','NAV','PUBLISHED_RATE','YIELD','VOLUME'].includes(input.kind)) throw new TypeError('Unknown observation type');
    if (!['LIVE','DELAYED','END_OF_DAY','PUBLISHED_RATE'].includes(input.dataClass)) throw new TypeError('Unknown observation data class');
    if (typeof input.value !== 'string' || !/^(0|[1-9][0-9]*)(\.[0-9]{1,8})?$/.test(input.value)) {
      throw new TypeError('Observation value must be an exact non-negative decimal string');
    }
    if (typeof input.sourceId !== 'string' || !input.sourceId.trim()) throw new TypeError('Source identity required');
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
      const result = await client.query(
        `INSERT INTO finance.market_observations
          (product_id,source_id,observation_type,value,currency,unit,data_class,
           observed_at,fetched_at,source_revision,retain_until,effective_from,effective_to)
         VALUES ($1,$2,$3,$4::numeric,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (product_id,source_id,observation_type,observed_at,source_revision)
         DO NOTHING RETURNING id`,
        [input.productId,input.sourceId,input.kind,input.value,input.currency || null,
          input.unit,input.dataClass,observed,fetched,input.sourceRevision || '0',retainedUntil,
          input.effectiveFrom || null,input.effectiveTo || null],
      );
      return { stored: result.rowCount === 1, observationId: result.rows[0]?.id || null };
    });
  }
  return { browse, latestPublishableObservation, appendObservation, transaction };
}
