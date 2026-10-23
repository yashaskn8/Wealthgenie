import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { Router } from 'express';
import { verifyJWT, isValidObjectId } from '../middleware/authMiddleware.js';
import { asyncHandler, createError, sendError } from '../middleware/errorHandler.js';
import { resolveCurrentFinancialProfile } from '../services/currentFinancialProfile.js';
import { DecisionInputError, fromPaise, DECISION_LEDGER_VERSION } from '../services/genieDecision/ledger.js';
import { calculateDecision, DECISION_TYPES } from '../services/genieDecision/decisionEngine.js';
import DecisionScenario from '../models/DecisionScenario.js';
import DecisionScenarioRevision from '../models/DecisionScenarioRevision.js';
import DecisionRun from '../models/DecisionRun.js';
import DecisionEvent from '../models/DecisionEvent.js';
import DecisionEventState from '../models/DecisionEventState.js';
import { appendDecisionEvent } from '../services/genieDecision/liveEvents.js';
import { verifyPersistenceIndexes } from '../services/persistenceIndexReadiness.js';
import {
  DecisionIntegrityUnavailable, decisionIntegrityReady, signDecisionReceipt, verifyDecisionReceipt,
} from '../services/genieDecision/integrity.js';

const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identity = id => String(id);
const isPlain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (status, code, message) => { throw createError(status, message, message, { code }); };
const own = (req, id) => ({ _id: id, userId: req.user.userId });
const ensureId = id => {
  if (!isValidObjectId(id)) fail(400, 'INVALID_DECISION_ID', 'Invalid scenario or report identifier.');
  return id;
};
const idempotency = (req, operation) => {
  const raw = req.headers['idempotency-key'];
  if (typeof raw !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(raw)) {
    fail(400, 'INVALID_IDEMPOTENCY_KEY', 'An Idempotency-Key header of 8–128 URL-safe characters is required.');
  }
  return hash([String(req.user.userId), operation, raw]);
};
const title = value => {
  if (typeof value !== 'string' || value.trim().length < 3 || value.trim().length > 100
      || /[\x00-\x1f]/.test(value)) fail(400, 'INVALID_DECISION_TITLE', 'Title must contain 3–100 readable characters.');
  return value.trim();
};
function exact(body, keys) {
  if (!isPlain(body) || Object.keys(body).some(k => !keys.includes(k)) || keys.some(k => !Object.hasOwn(body, k))) {
    fail(400, 'INVALID_DECISION_INPUT', 'Unexpected or missing scenario fields.');
  }
}
function profileMoney(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0
    || !Number.isSafeInteger(Math.round(value * 100))
    || Math.abs(value * 100 - Math.round(value * 100)) > 0.000001) {
    fail(422, 'REQUIRES_INPUTS', `Canonical ${field} is missing or cannot be represented in paise.`);
  }
  return fromPaise(BigInt(Math.round(value * 100)));
}
function canonicalProfileFacts(profile) {
  return {
    openingLiquidCash: profileMoney(profile?.liquidSavings, 'liquidSavings'),
    monthlyTakeHome: profileMoney(profile?.monthlyTakeHome, 'monthlyTakeHome'),
    declaredMonthlySavings: profileMoney(profile?.monthlySavings, 'monthlySavings'),
  };
}
function fingerprintCurrentFacts(profile) {
  return hash(canonicalProfileFacts(profile));
}
function sameProfile(current, scenario) {
  return Boolean(current?.profile && current?.state?.resolutionStatus === 'CURRENT'
    && identity(current.profile._id) === identity(scenario.profileId)
    && current.state.revision === scenario.profileStateRevision
    && current.profile.version === scenario.profileVersion
    && Number(current.profile.financialStateFence ?? 0) === scenario.profileFinancialFence
    && (typeof scenario.profileFactsHash === 'string')
    && (() => {
      try { return scenario.profileFactsHash === fingerprintCurrentFacts(current.profile); }
      catch { return false; }
    })());
}
function assertProfile(current, scenario) {
  if (!sameProfile(current, scenario)) {
    fail(409, 'DECISION_STALE_PROFILE', 'Financial profile changed. Create a new scenario using the current profile.');
  }
}
function sourceProfile(current) {
  if (!current.profile || current.state.resolutionStatus !== 'CURRENT') {
    fail(422, 'REQUIRES_INPUTS', 'Complete your financial profile before using GenieDecision.');
  }
  return {
    profileId: current.profile._id,
    profileStateRevision: Number(current.state.revision),
    profileVersion: Number(current.profile.version),
    profileFinancialFence: Number(current.profile.financialStateFence ?? 0),
    profileFactsHash: fingerprintCurrentFacts(current.profile),
  };
}
function normalizeScenario(body, scenarioType, expected = false) {
  const fields = expected
    ? ['expectedRevision', 'title', 'baseline', 'horizonMonths', 'goalReservations', 'details']
    : ['profileId', 'expectedProfileStateRevision', 'scenarioType', 'title',
      'baseline', 'horizonMonths', 'goalReservations', 'details'];
  exact(body, fields);
  if (expected && (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1)) {
    fail(400, 'INVALID_DECISION_REVISION', 'Expected scenario revision is required.');
  }
  if (!expected && (!isValidObjectId(body.profileId) || !Number.isSafeInteger(body.expectedProfileStateRevision)
     || body.expectedProfileStateRevision < 1 || !DECISION_TYPES.includes(body.scenarioType))) {
    fail(400, 'INVALID_DECISION_BINDING', 'Current profile identity, revision and scenario type are required.');
  }
  exact(body.baseline, ['monthlyLivingExpenses', 'monthlyDebtPayments', 'monthlyInvestments']);
  return {
    title: title(body.title),
    horizonMonths: body.horizonMonths,
    baseline: body.baseline,
    goalReservations: body.goalReservations,
    details: body.details,
    scenarioType: scenarioType || body.scenarioType,
  };
}
function compute(current, payload) {
  const profile = current.profile;
  const baseline = { ...canonicalProfileFacts(profile), ...payload.baseline };
  const report = calculateDecision({
    scenarioType: payload.scenarioType,
    baseline, horizonMonths: payload.horizonMonths,
    goalReservations: payload.goalReservations, details: payload.details,
  });
  return {
    ...report,
    profileFacts: {
      openingLiquidCash: baseline.openingLiquidCash,
      monthlyTakeHome: baseline.monthlyTakeHome,
      declaredMonthlySavings: baseline.declaredMonthlySavings,
    },
    financialInputFingerprint: hash({ baseline, scenarioType: payload.scenarioType,
      horizonMonths: payload.horizonMonths, goalReservations: payload.goalReservations,
      details: payload.details }),
  };
}
function scenarioDto(row) {
  return {
    id: identity(row._id), profileId: identity(row.profileId), scenarioType: row.scenarioType,
    revision: row.revision, title: row.title, lastRunId: row.lastRunId ? identity(row.lastRunId) : null,
    profileStateRevision: row.profileStateRevision,
    createdAt: row.createdAt, updatedAt: row.updatedAt,
  };
}
function revisionReceiptContext(scenario, revision, inputHash) {
  return {
    userId: identity(scenario.userId), scenarioId: identity(scenario._id),
    revision, inputHash, scenarioType: scenario.scenarioType,
    profileId: identity(scenario.profileId), profileFactsHash: scenario.profileFactsHash,
    profileStateRevision: scenario.profileStateRevision, profileVersion: scenario.profileVersion,
    profileFinancialFence: scenario.profileFinancialFence,
  };
}
function reportReceiptContext(run) {
  return {
    userId: identity(run.userId), scenarioId: identity(run.scenarioId),
    revision: run.revision, profileId: identity(run.profileId),
    profileFactsHash: run.profileFactsHash, inputHash: run.inputHash, runKeyHash: run.runKeyHash,
    profileStateRevision: run.profileStateRevision, profileVersion: run.profileVersion,
    profileFinancialFence: run.profileFinancialFence, issuedAt: run.issuedAt,
  };
}
function checkRevision(revision, scenario) {
  if (!revision || revision.inputHash !== hash(revision.payload)
      || !verifyDecisionReceipt(revision, 'scenario_revision',
        revisionReceiptContext(scenario, revision.revision, revision.inputHash), revision.payload)
      || (scenario.revision === revision.revision
        && (scenario.title !== revision.payload.title
          || scenario.scenarioType !== revision.payload.scenarioType))) {
    fail(503, 'DECISION_REVISION_INTEGRITY_FAILURE',
      'Stored scenario revision failed authenticated integrity verification.');
  }
}
function makeRevision({ scenario, revision, payload }) {
  const inputHash = hash(payload);
  return {
    userId: scenario.userId, scenarioId: scenario._id,
    revision, payload, inputHash,
    ...signDecisionReceipt('scenario_revision',
      revisionReceiptContext(scenario, revision, inputHash), payload),
  };
}
function checkRunRecord(run) {
  if (!run || !run.result || typeof run.result !== 'object'
      || !/^[a-f0-9]{64}$/.test(run.resultHash || '')
      || hash(run.result) !== run.resultHash
      || !verifyDecisionReceipt(run, 'decision_run', reportReceiptContext(run),
        { resultHash: run.resultHash })) {
    fail(503, 'DECISION_REPORT_INTEGRITY_FAILURE',
      'The saved decision report failed integrity verification.');
  }
}
async function checkCurrentRunPointers(userId, scenarios) {
  const withRun = scenarios.filter(row => row.lastRunId);
  if (!withRun.length) return;
  const records = await DecisionRun.find({
    userId, _id: { $in: withRun.map(row => row.lastRunId) },
  }).lean();
  const byId = new Map(records.map(run => [identity(run._id), run]));
  for (const scenario of withRun) {
    const run = byId.get(identity(scenario.lastRunId));
    if (!run || identity(run.scenarioId) !== identity(scenario._id)
        || run.revision !== scenario.revision) {
      fail(503, 'DECISION_RUN_POINTER_INTEGRITY_FAILURE',
        'The current scenario report pointer could not be verified.');
    }
    checkRunRecord(run);
  }
}
function reportDto(run, current, scenario = null) {
  // Both financial-profile and scenario-revision pointers must remain current.
  // Independently verify the immutable result snapshot before presenting it.
  checkRunRecord(run);
  const staleProfile = !sameProfile(current, run);
  const staleScenario = !scenario || scenario.revision !== run.revision;
  const staleCalculationPolicy = run.result.modelVersion !== DECISION_LEDGER_VERSION;
  // An out-of-band mutation of the financial source can otherwise bypass the
  // application-level version contract. Compare the exact canonical facts
  // captured in the immutable report, rather than trusting just revision IDs.
  const sourceFacts = run.result.profileFacts;
  const expected = [
    ['openingLiquidCash', 'liquidSavings'],
    ['monthlyTakeHome', 'monthlyTakeHome'],
    ['declaredMonthlySavings', 'monthlySavings'],
  ];
  const staleInputs = !sourceFacts || expected.some(([key, field]) => {
    try {
      return sourceFacts[key] !== profileMoney(current?.profile?.[field], field);
    } catch {
      return true;
    }
  });
  const historical = staleProfile || staleScenario || staleCalculationPolicy || staleInputs;
  return {
    id: identity(run._id), scenarioId: identity(run.scenarioId), scenarioRevision: run.revision,
    status: historical ? 'HISTORICAL' : run.result.status,
    reasonCodes: [
      ...(staleProfile ? ['DECISION_SOURCE_PROFILE_SUPERSEDED'] : []),
      ...(staleScenario ? ['DECISION_SCENARIO_REVISION_SUPERSEDED'] : []),
      ...(staleCalculationPolicy ? ['DECISION_CALCULATION_POLICY_SUPERSEDED'] : []),
      ...(staleInputs ? ['DECISION_CANONICAL_FACTS_CHANGED'] : []),
    ],
    asOf: run.issuedAt, originalStatus: run.result.status, result: run.result,
  };
}
async function transaction(work) {
  const session = await mongoose.startSession();
  try {
    let answer;
    await session.withTransaction(async () => { answer = await work(session); }, {
      readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' },
    });
    return answer;
  } finally { await session.endSession(); }
}
async function ownedScenario(req, session = null) {
  const query = DecisionScenario.findOne(own(req, ensureId(req.params.id)));
  if (session) query.session(session);
  const scenario = await query.lean();
  if (!scenario) fail(404, 'DECISION_NOT_FOUND', 'Scenario not found.');
  return scenario;
}
const handleInput = fn => asyncHandler(async (req, res) => {
  try { await fn(req, res); }
  catch (err) {
    if (err instanceof DecisionInputError) return sendError(req, res, 422, err.message, err.code);
    if (err instanceof DecisionIntegrityUnavailable) {
      return sendError(req, res, 503,
        'Authenticated decision report signing is unavailable.',
        'DECISION_INTEGRITY_UNAVAILABLE');
    }
    if (err?.code === 11000 || err?.name === 'MongoServerError' && err?.code === 11000) {
      return sendError(req, res, 409, 'Concurrent or duplicate scenario mutation.', 'DECISION_CONFLICT');
    }
    if (err?.hasErrorLabel?.('TransientTransactionError') || err?.name === 'VersionError') {
      return sendError(req, res, 409, 'Concurrent financial state update. Retry after refreshing.', 'DECISION_CONFLICT');
    }
    throw err;
  }
});

const requireDecisionIndexes = asyncHandler(async (_req, _res, next) => {
  // The production instance must have explicit migrations completed. Do not
  // create indexes in request processing: missing unique keys break quotas
  // and exactly-once guarantees under concurrent writers.
  await verifyPersistenceIndexes({
    models: [DecisionScenario, DecisionScenarioRevision, DecisionRun, DecisionEvent, DecisionEventState],
    scope: 'persistence',
  });
  next();
});

export function createDecisionsRouter({ resolveProfile = resolveCurrentFinancialProfile } = {}) {
  const router = Router();
  // GenieDecision contains personally sensitive financial scenarios. Neither
  // authenticated results nor failures may be cached by browsers or proxies.
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'private, no-store, max-age=0');
    res.set('Pragma', 'no-cache');
    next();
  });
  router.use(verifyJWT);

  router.get('/data-availability', handleInput(async (req, res) => {
    const current = await resolveProfile({ userId: req.user.userId, requireRecommendation: false });
    const currentProfile = Boolean(current.profile && current.state.resolutionStatus === 'CURRENT');
    const optionalFact = (value, field) => {
      try { return profileMoney(value, field); } catch { return null; }
    };
    const facts = currentProfile ? {
      openingLiquidCash: optionalFact(current.profile.liquidSavings, 'liquidSavings'),
      monthlyTakeHome: optionalFact(current.profile.monthlyTakeHome, 'monthlyTakeHome'),
      declaredMonthlySavings: optionalFact(current.profile.monthlySavings, 'monthlySavings'),
    } : { openingLiquidCash: null, monthlyTakeHome: null, declaredMonthlySavings: null };
    const complete = Object.values(facts).every(value => value !== null);
    // Presence alone is not readiness: there must be positive income and
    // room for nonnegative expenses/debt before any savings can reconcile.
    const financiallyCoherent = complete
      && Number(facts.monthlyTakeHome) > 0
      && Number(facts.monthlyTakeHome) >= Number(facts.declaredMonthlySavings);
    const authenticatedReports = decisionIntegrityReady();
    res.json({
      available: currentProfile && financiallyCoherent && authenticatedReports,
      authenticatedReports,
      profileId: currentProfile ? identity(current.profile._id) : null,
      profileStateRevision: currentProfile ? current.state.revision : null,
      openingLiquidCashAvailable: facts.openingLiquidCash !== null,
      profileFacts: facts, requiredInputsComplete: financiallyCoherent,
      externalFinancialEvidence: 'UNAVAILABLE',
      llmRequired: false, providerForecastAvailable: false,
    });
  }));

  // Ephemeral, deterministic recomputation for all four scenario types.
  // Never create a scenario, transaction, recommendation, or market-data claim.
  router.post('/simulate', handleInput(async (req, res) => {
    const payload = normalizeScenario(req.body);
    const current = await resolveProfile({ userId: req.user.userId, requireRecommendation: false });
    const source = sourceProfile(current);
    if (identity(source.profileId) !== req.body.profileId
        || source.profileStateRevision !== req.body.expectedProfileStateRevision) {
      fail(409, 'DECISION_STALE_PROFILE', 'Refresh the current financial profile before simulating.');
    }
    const result = compute(current, payload);
    const final = await resolveProfile({ userId: req.user.userId, requireRecommendation: false });
    assertProfile(final, source);
    return res.json({
      previewOnly: true, status: 'PARTIAL', result,
      profileStateRevision: source.profileStateRevision,
      sourceStatus: 'CURRENT_CANONICAL_PROFILE_WITH_UNVERIFIED_HYPOTHETICAL_INPUTS',
    });
  }));

  router.post('/scenarios', requireDecisionIndexes, handleInput(async (req, res) => {
    const payload = normalizeScenario(req.body);
    if (!decisionIntegrityReady()) {
      fail(503, 'DECISION_INTEGRITY_UNAVAILABLE', 'Authenticated receipt signing is unavailable.');
    }
    const createKeyHash = idempotency(req, 'decision.create');
    const createPayloadHash = hash(req.body);
    const prior = await DecisionScenario.findOne({ userId: req.user.userId, createKeyHash }).lean();
    if (prior) {
      if (prior.createPayloadHash !== createPayloadHash) {
        fail(409, 'IDEMPOTENCY_PAYLOAD_CONFLICT', 'Idempotency key already belongs to another scenario.');
      }
      const signed = await DecisionScenarioRevision.findOne({
        userId: req.user.userId, scenarioId: prior._id, revision: prior.revision,
      }).lean();
      checkRevision(signed, prior);
      await checkCurrentRunPointers(req.user.userId, [prior]);
      return res.status(200).json({ scenario: scenarioDto(prior), replayed: true });
    }
    const current = await resolveProfile({ userId: req.user.userId, requireRecommendation: false });
    const source = sourceProfile(current);
    if (identity(source.profileId) !== req.body.profileId
      || source.profileStateRevision !== req.body.expectedProfileStateRevision) {
      fail(409, 'DECISION_STALE_PROFILE', 'Refresh your canonical financial profile.');
    }
    compute(current, payload); // Validation only; no report is published for a draft.
    const doc = await transaction(async session => {
      const fresh = await resolveProfile({
        userId: req.user.userId, requireRecommendation: false, session,
      });
      assertProfile(fresh, source);
      // A database-unique (userId, quotaSlot) index prevents a concurrent
      // request from racing past the 50-scenario bound across replicas.
      const occupied = await DecisionScenario.find({ userId: req.user.userId })
        .select('quotaSlot').session(session).lean();
      const used = new Set(occupied.map(item => item.quotaSlot));
      let quotaSlot = null;
      for (let slot = 0; slot < 50; slot += 1) {
        if (!used.has(slot)) { quotaSlot = slot; break; }
      }
      if (quotaSlot === null) fail(429, 'DECISION_SCENARIO_LIMIT', 'Maximum of 50 saved scenarios reached.');
      const [created] = await DecisionScenario.create([{
        userId: req.user.userId, ...source,
        scenarioType: payload.scenarioType, title: payload.title, quotaSlot,
        createKeyHash, createPayloadHash,
      }], { session });
      await DecisionScenarioRevision.create([
        makeRevision({ scenario: created.toObject(), revision: 1, payload }),
      ], { session });
      await appendDecisionEvent(session, {
        userId: req.user.userId, type: 'SCENARIO_CREATED', scenarioId: created._id, revision: 1,
      });
      return created.toObject();
    }).catch(async error => {
      // Two replicas may commit the same key concurrently. A unique-index
      // collision must converge on the durable receipt, not become a false
      // failed create. A quota-slot collision with a DIFFERENT key stays a 409.
      const saved = await DecisionScenario.findOne({ userId: req.user.userId, createKeyHash }).lean();
      if (!saved) throw error;
      if (saved.createPayloadHash !== createPayloadHash) {
        fail(409, 'IDEMPOTENCY_PAYLOAD_CONFLICT', 'Idempotency key already belongs to another scenario.');
      }
      const signed = await DecisionScenarioRevision.findOne({
        userId: req.user.userId, scenarioId: saved._id, revision: saved.revision,
      }).lean();
      checkRevision(signed, saved);
      await checkCurrentRunPointers(req.user.userId, [saved]);
      return { ...saved, replayedAfterRace: true };
    });
    res.status(doc.replayedAfterRace ? 200 : 201).json({
      scenario: scenarioDto(doc), replayed: Boolean(doc.replayedAfterRace),
    });
  }));

  router.get('/scenarios', handleInput(async (req, res) => {
    const scenarios = await DecisionScenario.find({ userId: req.user.userId })
      .sort({ createdAt: -1 }).limit(50).lean();
    if (scenarios.length) {
      // Do not display attacker-edited scenario titles without checking the
      // signed current revision; bound this request to 50 revision records.
      const revisions = await DecisionScenarioRevision.find({
        userId: req.user.userId,
        $or: scenarios.map(row => ({ scenarioId: row._id, revision: row.revision })),
      }).lean();
      const byIdentity = new Map(revisions.map(row => [`${row.scenarioId}:${row.revision}`, row]));
      for (const scenario of scenarios) {
        checkRevision(byIdentity.get(`${scenario._id}:${scenario.revision}`), scenario);
      }
    }
    await checkCurrentRunPointers(req.user.userId, scenarios);
    res.json({ scenarios: scenarios.map(scenarioDto), maxReturned: 50 });
  }));

  router.get('/scenarios/:id', handleInput(async (req, res) => {
    const scenario = await ownedScenario(req);
    const revision = await DecisionScenarioRevision.findOne({
      userId: req.user.userId, scenarioId: scenario._id, revision: scenario.revision,
    }).lean();
    checkRevision(revision, scenario);
    await checkCurrentRunPointers(req.user.userId, [scenario]);
    res.json({ scenario: scenarioDto(scenario), payload: revision.payload, inputHash: revision.inputHash });
  }));

  router.patch('/scenarios/:id', requireDecisionIndexes, handleInput(async (req, res) => {
    const first = await ownedScenario(req);
    const payload = normalizeScenario(req.body, first.scenarioType, true);
    const current = await resolveProfile({ userId: req.user.userId, requireRecommendation: false });
    assertProfile(current, first);
    compute(current, payload);
    const updated = await transaction(async session => {
      const currentScenario = await ownedScenario(req, session);
      const currentRevision = await DecisionScenarioRevision.findOne({
        userId: req.user.userId, scenarioId: currentScenario._id,
        revision: currentScenario.revision,
      }).session(session).lean();
      checkRevision(currentRevision, currentScenario);
      if (currentScenario.revision !== req.body.expectedRevision) {
        fail(409, 'DECISION_REVISION_CONFLICT', 'Scenario was changed by another request.');
      }
      if (currentScenario.revision >= 200) {
        fail(429, 'DECISION_REVISION_LIMIT',
          'A saved scenario supports at most 200 revisions. Start a new scenario for further changes.');
      }
      const latest = await resolveProfile({
        userId: req.user.userId, requireRecommendation: false, session,
      });
      assertProfile(latest, currentScenario);
      const next = await DecisionScenario.findOneAndUpdate({
        ...own(req, currentScenario._id), revision: currentScenario.revision,
      }, { $inc: { revision: 1 }, $set: { title: payload.title, lastRunId: null } },
      { new: true, session }).lean();
      if (!next) fail(409, 'DECISION_REVISION_CONFLICT', 'Scenario was concurrently updated.');
      await DecisionScenarioRevision.create([
        makeRevision({ scenario: next, revision: next.revision, payload }),
      ], { session });
      await appendDecisionEvent(session, {
        userId: req.user.userId, type: 'SCENARIO_UPDATED',
        scenarioId: next._id, revision: next.revision,
      });
      return next;
    });
    res.json({ scenario: scenarioDto(updated) });
  }));

  router.post('/scenarios/:id/evaluate', requireDecisionIndexes, handleInput(async (req, res) => {
    exact(req.body, ['expectedRevision']);
    if (!Number.isSafeInteger(req.body.expectedRevision) || req.body.expectedRevision < 1) {
      fail(400, 'INVALID_DECISION_REVISION', 'A positive expected revision is required.');
    }
    const key = idempotency(req, `decision.evaluate:${req.params.id}`);
    const first = await ownedScenario(req);
    // A committed idempotent run must replay from its *pinned* revision even
    // after a subsequent edit. It must never be recomputed from today's inputs.
    const prior = await DecisionRun.findOne({ userId: req.user.userId, runKeyHash: key }).lean();
    if (prior) {
      if (identity(prior.scenarioId) !== identity(first._id)
        || prior.revision !== req.body.expectedRevision) {
        fail(409, 'IDEMPOTENCY_PAYLOAD_CONFLICT', 'Evaluation key was used for different inputs.');
      }
      const originalRevision = await DecisionScenarioRevision.findOne({
        userId: req.user.userId, scenarioId: first._id, revision: prior.revision,
      }).lean();
      checkRevision(originalRevision, first);
      if (prior.inputHash !== originalRevision.inputHash) {
        fail(409, 'IDEMPOTENCY_PAYLOAD_CONFLICT', 'Stored report input does not match the requested revision.');
      }
      const fresh = await resolveProfile({ userId: req.user.userId, requireRecommendation: false });
      return res.status(200).json({ run: reportDto(prior, fresh, first), replayed: true });
    }
    if (first.revision !== req.body.expectedRevision) {
      fail(409, 'DECISION_REVISION_CONFLICT', 'Scenario revision changed. Refresh before evaluating.');
    }
    const revision = await DecisionScenarioRevision.findOne({
      userId: req.user.userId, scenarioId: first._id, revision: first.revision,
    }).lean();
    checkRevision(revision, first);
    const current = await resolveProfile({ userId: req.user.userId, requireRecommendation: false });
    assertProfile(current, first);
    const result = compute(current, revision.payload);
    const run = await transaction(async session => {
      const latestScenario = await ownedScenario(req, session);
      if (latestScenario.revision !== first.revision
        || latestScenario.runGeneration !== first.runGeneration) {
        fail(409, 'DECISION_REVISION_CONFLICT', 'Concurrent edit or evaluation invalidated this run.');
      }
      const latest = await resolveProfile({
        userId: req.user.userId, requireRecommendation: false, session,
      });
      assertProfile(latest, latestScenario);
      const runCount = await DecisionRun.countDocuments({
        userId: req.user.userId, scenarioId: first._id,
      }).session(session);
      if (runCount >= 20) fail(429, 'DECISION_REPORT_LIMIT',
        'Maximum of 20 retained reports per scenario reached. Delete the scenario to clear the history.');
      const storedRun = {
        userId: req.user.userId, scenarioId: first._id, revision: first.revision,
        profileId: first.profileId, profileStateRevision: first.profileStateRevision,
        profileVersion: first.profileVersion, profileFinancialFence: first.profileFinancialFence,
        profileFactsHash: first.profileFactsHash, runKeyHash: key, inputHash: revision.inputHash,
        result, resultHash: hash(result), issuedAt: new Date().toISOString(),
      };
      const [created] = await DecisionRun.create([{
        ...storedRun,
        ...signDecisionReceipt('decision_run', reportReceiptContext(storedRun),
          { resultHash: storedRun.resultHash }),
      }], { session });
      const head = await DecisionScenario.findOneAndUpdate({
        ...own(req, first._id), revision: first.revision, runGeneration: first.runGeneration,
      }, { $set: { lastRunId: created._id }, $inc: { runGeneration: 1 } },
      { session, new: true }).lean();
      if (!head) fail(409, 'DECISION_REVISION_CONFLICT', 'Concurrent scenario evaluation detected.');
      await appendDecisionEvent(session, {
        userId: req.user.userId, type: 'RUN_PUBLISHED',
        scenarioId: first._id, revision: first.revision,
      });
      return created.toObject();
    }).catch(async error => {
      // Retry convergence for a concurrently committed evaluation keyed
      // to the same scenario revision and exact persisted input fingerprint.
      const saved = await DecisionRun.findOne({
        userId: req.user.userId, runKeyHash: key,
      }).lean();
      if (!saved) throw error;
      if (identity(saved.scenarioId) !== identity(first._id)
        || saved.revision !== first.revision || saved.inputHash !== revision.inputHash) {
        fail(409, 'IDEMPOTENCY_PAYLOAD_CONFLICT', 'Evaluation key does not belong to the same scenario inputs.');
      }
      return { ...saved, replayedAfterRace: true };
    });
    // Re-resolve after commit: a parallel profile update must never yield a
    // newly published report falsely labeled CURRENT.
    const afterCommit = await resolveProfile({ userId: req.user.userId, requireRecommendation: false });
    const headAfterCommit = await DecisionScenario.findOne(own(req, first._id)).lean();
    res.status(run.replayedAfterRace ? 200 : 201).json({
      run: reportDto(run, afterCommit, headAfterCommit),
      replayed: Boolean(run.replayedAfterRace),
    });
  }));

  router.get('/runs/:id', handleInput(async (req, res) => {
    const run = await DecisionRun.findOne(own(req, ensureId(req.params.id))).lean();
    if (!run) fail(404, 'DECISION_RUN_NOT_FOUND', 'Decision report not found.');
    const current = await resolveProfile({ userId: req.user.userId, requireRecommendation: false });
    const scenario = await DecisionScenario.findOne(own(req, run.scenarioId)).lean();
    if (!scenario) fail(404, 'DECISION_RUN_NOT_FOUND', 'Decision report not found.');
    res.json({ run: reportDto(run, current, scenario) });
  }));

  router.get('/scenarios/:id/runs', handleInput(async (req, res) => {
    const scenario = await ownedScenario(req);
    const records = await DecisionRun.find({
      userId: req.user.userId, scenarioId: scenario._id,
    }).sort({ createdAt: -1 }).limit(20).lean();
    const current = await resolveProfile({ userId: req.user.userId, requireRecommendation: false });
    // A navigation list must not echo 20 full 360-month financial ledgers.
    // Verify each snapshot but return minimal owner-scoped metadata.
    const runs = records.map(record => {
      const { result, ...metadata } = reportDto(record, current, scenario);
      void result;
      return metadata;
    });
    res.json({ runs, maxReturned: 20 });
  }));

  router.delete('/scenarios/:id', requireDecisionIndexes, handleInput(async (req, res) => {
    exact(req.body, ['expectedRevision']);
    const deleted = await transaction(async session => {
      const scenario = await ownedScenario(req, session);
      if (scenario.revision !== req.body.expectedRevision) {
        fail(409, 'DECISION_REVISION_CONFLICT', 'Refresh before deleting this scenario.');
      }
      const removed = await DecisionScenario.deleteOne({
        ...own(req, scenario._id), revision: scenario.revision,
      }, { session });
      if (removed.deletedCount !== 1) fail(409, 'DECISION_REVISION_CONFLICT', 'Scenario changed during deletion.');
      await DecisionScenarioRevision.deleteMany({ userId: req.user.userId, scenarioId: scenario._id }, { session });
      await DecisionRun.deleteMany({ userId: req.user.userId, scenarioId: scenario._id }, { session });
      await appendDecisionEvent(session, {
        userId: req.user.userId, type: 'SCENARIO_DELETED',
        scenarioId: scenario._id, revision: scenario.revision,
      });
      return identity(scenario._id);
    });
    res.json({ deleted: true, scenarioId: deleted });
  }));

  return router;
}

export default createDecisionsRouter();
