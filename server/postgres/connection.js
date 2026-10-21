let instance = null;
let pending = null;
/** Opt-in PostgreSQL source authority. Existing MongoDB flows remain usable without this flag. */
export async function getFinancialPostgresPool(env = process.env) {
  if (env.FINANCIAL_POSTGRES_ENABLED !== 'true') return null;
  if (!env.FINANCIAL_POSTGRES_URL) {
    const error = new Error('FINANCIAL_POSTGRES_URL_REQUIRED');
    error.code = 'FINANCIAL_POSTGRES_URL_REQUIRED';
    throw error;
  }
  if (instance) return instance;
  if (pending) return pending;
  pending = (async () => {
    let Pool;
    try {
      ({ Pool } = await import('pg'));
    } catch {
      const error = new Error('PostgreSQL runtime driver is unavailable; install the node-postgres pg package before enabling');
      error.code = 'FINANCIAL_POSTGRES_DRIVER_MISSING';
      throw error;
    }
    const pool = new Pool({
      connectionString: env.FINANCIAL_POSTGRES_URL,
      max: 5,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 10000,
      statement_timeout: 10000,
    });
    try {
      await pool.query('SELECT 1 FROM finance.categories LIMIT 1');
      instance = pool;
      return pool;
    } catch (error) {
      await pool.end();
      throw error;
    }
  })();
  try { return await pending; } finally { pending = null; }
}
export async function closeFinancialPostgresPool() {
  const old = instance;
  instance = null;
  if (old) await old.end();
}
