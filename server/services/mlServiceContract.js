import { trace } from '@opentelemetry/api';

const RISK_CATEGORIES = new Set([
  'Conservative', 'Conservative-Moderate', 'Moderate', 'Moderate-Aggressive', 'Aggressive',
]);
const RISK_TOLERANCES = new Set(['Conservative', 'Moderate', 'Aggressive']);
const INVESTMENT_GOALS = new Set(['Retirement', 'Wealth Growth', 'Tax Saving', 'Emergency Fund']);
const ML_TARGET_CLASSES = new Set(['Equity_MF', 'ELSS', 'ETF', 'Debt_MF', 'FD', 'RBI_Bond']);
const FEATURE_SCHEMA_VERSION = 'recommendation-features-4.0.0';

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export function buildTracingHeaders(correlationId = null) {
  const headers = {};
  const activeSpan = trace.getActiveSpan();
  if (activeSpan) {
    const context = activeSpan.spanContext();
    headers.traceparent = `00-${context.traceId}-${context.spanId}-01`;
    if (!correlationId) correlationId = context.traceId;
  }
  if (correlationId) {
    const value = String(correlationId);
    headers['X-Correlation-ID'] = value;
    if (!headers.traceparent) {
      const traceId = value.replace(/[^a-fA-F0-9]/g, '').padEnd(32, '0').slice(0, 32);
      headers.traceparent = `00-${traceId}-${'0'.repeat(15)}1-01`;
    }
  }
  return headers;
}

export function buildPredictionRequest(profileData) {
  const request = {
    feature_schema_version: profileData.feature_schema_version,
    age: finiteNumber(profileData.age),
    monthly_take_home: finiteNumber(profileData.monthly_take_home),
    monthly_savings: finiteNumber(profileData.monthly_savings),
    liquid_savings: finiteNumber(profileData.liquid_savings),
    emi_burden_pct: finiteNumber(profileData.emi_burden_pct),
    financial_dependents: finiteNumber(profileData.financial_dependents),
    emergency_fund_months: finiteNumber(profileData.emergency_fund_months),
    risk_tolerance: profileData.risk_tolerance,
    investment_goals: Array.isArray(profileData.investment_goals) ? [...profileData.investment_goals] : null,
    investment_horizon_years: finiteNumber(profileData.investment_horizon_years),
    deployable_lump_sum: finiteNumber(profileData.deployable_lump_sum),
    risk_capacity_score: finiteNumber(profileData.risk_capacity_score),
    final_suitability_risk: profileData.final_suitability_risk,
  };

  const numbersValid = Object.entries(request)
    .filter(([key]) => !['feature_schema_version', 'risk_tolerance', 'investment_goals', 'final_suitability_risk'].includes(key))
    .every(([, value]) => value !== null);
  if (!numbersValid
    || request.feature_schema_version !== FEATURE_SCHEMA_VERSION
    || !RISK_CATEGORIES.has(request.final_suitability_risk)
    || !RISK_TOLERANCES.has(request.risk_tolerance)
    || !request.investment_goals?.length
    || request.investment_goals.some(goal => !INVESTMENT_GOALS.has(goal))) return null;
  return request;
}

export function normalizePredictionResponse(value) {
  if (!value || typeof value !== 'object') return null;
  if (![value.primary, value.secondary, value.tertiary].every(nonEmptyString)) return null;
  const rankedClasses = [value.primary, value.secondary, value.tertiary];
  if (new Set(rankedClasses).size !== rankedClasses.length
    || rankedClasses.some(label => !ML_TARGET_CLASSES.has(label))) return null;
  if (!value.confidence_scores || typeof value.confidence_scores !== 'object' || Array.isArray(value.confidence_scores)) return null;
  if (Object.keys(value.confidence_scores).length !== ML_TARGET_CLASSES.size
    || Object.keys(value.confidence_scores).some(label => !ML_TARGET_CLASSES.has(label))) return null;
  if (!Object.values(value.confidence_scores).every(score => (
    typeof score === 'number' && Number.isFinite(score) && score >= 0 && score <= 1
  ))) return null;
  if (!Array.isArray(value.decision_path) || !value.decision_path.every(nonEmptyString)) return null;
  if (!nonEmptyString(value.model_version)) return null;
  if (!nonEmptyString(value.dataset_version)) return null;
  if (value.feature_schema_version !== FEATURE_SCHEMA_VERSION) return null;
  if (value.explanation !== null && value.explanation !== undefined && typeof value.explanation !== 'object') return null;

  return {
    primary: value.primary,
    secondary: value.secondary,
    tertiary: value.tertiary,
    confidence_scores: Object.fromEntries(
      Object.entries(value.confidence_scores),
    ),
    decision_path: [...value.decision_path],
    explanation: value.explanation ?? null,
    model_version: value.model_version,
    dataset_version: value.dataset_version,
    feature_schema_version: value.feature_schema_version,
    cited_chunk_ids: Array.isArray(value.cited_chunk_ids) ? [...value.cited_chunk_ids] : [],
    fallback: value.fallback === true,
  };
}

export function buildRagQueryRequest({ query, top_k = 4, jurisdiction = "IN" }) {
  if (!nonEmptyString(query) || query.trim().length < 3) return null;
  const parsedTopK = Math.trunc(Number(top_k));
  if (!Number.isFinite(parsedTopK) || parsedTopK < 1 || parsedTopK > 20) return null;
  const normalizedJurisdiction = typeof jurisdiction === "string" ? jurisdiction.trim().toUpperCase() : "";
  if (!/^[A-Z]{2}$/.test(normalizedJurisdiction)) return null;
  return { question: query.trim(), top_k: parsedTopK, jurisdiction: normalizedJurisdiction };
}

export function normalizeRagResponse(value) {
  if (!value || typeof value !== 'object' || !nonEmptyString(value.answer)) return null;
  if (typeof value.grounded !== 'boolean') return null;
  if (!Array.isArray(value.citations) || !Array.isArray(value.retrieved_chunks)) return null;
  if (!value.metrics || typeof value.metrics !== 'object' || Array.isArray(value.metrics)) return null;
  if (!value.grounded) {
    // Never forward evidence that the upstream service explicitly disowned.
    return { ...value, citations: [], retrieved_chunks: [] };
  }
  if (value.citations.length === 0 || value.retrieved_chunks.length === 0) return null;
  const chunksById = new Map();
  for (const retrieved of value.retrieved_chunks) {
    const chunk = retrieved?.chunk;
    if (typeof chunk?.chunk_id !== 'string' || !chunk.chunk_id
        || typeof chunk.content !== 'string' || !chunk.content.trim()
        || chunk.lifecycle_state !== 'ACTIVE'
        || typeof chunk.metadata?.source !== 'string'
        || typeof chunk.metadata?.title !== 'string'
        || chunksById.has(chunk.chunk_id)) return null;
    chunksById.set(chunk.chunk_id, chunk);
  }
  const citedIds = new Set();
  for (const citation of value.citations) {
    const chunk = chunksById.get(citation?.chunk_id);
    if (!chunk || citedIds.has(citation.chunk_id)
        || citation.document_title !== chunk.metadata.title
        || citation.source !== chunk.metadata.source
        || typeof citation.excerpt !== 'string'
        || !citation.excerpt.trim()
        || !chunk.content.startsWith(citation.excerpt.endsWith('...')
          ? citation.excerpt.slice(0, -3) : citation.excerpt)) return null;
    citedIds.add(citation.chunk_id);
  }
  if (citedIds.size !== chunksById.size) return null;
  return { ...value, citations: value.citations, retrieved_chunks: value.retrieved_chunks };
}
