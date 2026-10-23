import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { Router } from 'express';
import { verifyJWT, isValidObjectId } from '../middleware/authMiddleware.js';
import { asyncHandler, createError, sendError } from '../middleware/errorHandler.js';
import { resolveCurrentFinancialProfile } from '../services/currentFinancialProfile.js';
import { DecisionInputError, fromPaise } from '../services/genieDecision/ledger.js';
import { calculateDecision, DECISION_TYPES } from '../services/genieDecision/decisionEngine.js';
import DecisionScenario from '../models/DecisionScenario.js';
import DecisionScenarioRevision from '../models/DecisionScenarioRevision.js';
import DecisionRun from '../models/DecisionRun.js';

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
function sameProfile(current, scenario) {
  return Boolean(current?.profile && current?.state?.resolutionStatus === 'CURRENT'
    && identity(current.profile._id) === identity(scenario.profileId)
    && current.state.revision === scenario.profileStateRevision
    && current.profile.version === scenario.profileVersion
    && Number(current.profile.financialStateFence ?? 0) === scenario.profileFinancialFence);
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
  const baseline = {
    openingLiquidCash: profileMoney(profile.liquidSavings, 'liquidSavings'),
    monthlyTakeHome: profileMoney(profile.monthlyTakeHome, 'monthlyTakeHome'),
    declaredMonthlySavings: profileMoney(profile.monthlySavings, 'monthlySavings'),
    ...payload.baseline,
  };
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
function reportDto(run, current) {
  const historical = !sameProfile(current, run);
  return {
    id: identity(run._id), scenarioId: identity(run.scenarioId), scenarioRevision: run.revision,
    status: historical ? 'HISTORICAL' : run.result.status,
    reasonCodes: historical ? ['DECISION_SOURCE_PROFILE_SUPERSEDED'] : [],
    asOf: run.createdAt, originalStatus: run.result.status, result: run.result,
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
    if (err?.code === 11000 || err?.name === 'MongoServerError' && err?.code === 11000) {
      return sendError(req, res, 409, 'Concurrent or duplicate scenario mutation.', 'DECISION_CONFLICT');
    }
    if (err?.hasErrorLabel?.('TransientTransactionError') || err?.name === 'VersionError') {
      return sendError(req, res, 409, 'Concurrent financial state update. Retry after refreshing.', 'DECISION_CONFLICT');
    }
    throw err;
  }
});

export function createDecisionsRouter({ resolveProfile = resolveCurrentFinancialProfile } = {}) {
  const router = Router();
  router.use(verifyJWT);

  router.get('/data-availability', handleInput(async (req, res) => {
    const current = await resolveProfile({ userId: req.user.userId, requireRecommendation: false });
    res.json({
      available: Boolean(current.profile && current.state.resolutionStatus === 'CURRENT'),
      profileId: current.profile ? identity(current.profile._id) : null,
      profileStateRevision: current.profile ? current.state.revision : null,
      openingLiquidCashAvailable: current.profile?.liquidSavings !== null
        && current.profile?.liquidSavings !== undefined,
      externalFinancialEvidence: 'UNAVAILABLE',
      llmRequired: false, providerForecastAvailable: false,
    });
  }));

  router.post('/scenarios', handleInput(async (req, res) => {
    const payload = normalizeScenario(req.body);
    const createKeyHash = idempotency(req, 'decision.create');
    const createPayloadHash = hash(req.body);
    const prior = await DecisionScenario.findOne({ userId: req.user.userId, createKeyHash }).lean();
    if (prior) {
      if (prior.createPayloadHash !== createPayloadHash) {
        fail(409, 'IDEMPOTENCY_PAYLOAD_CONFLICT', 'Idempotency key already belongs to another scenario.');
      }
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
      await DecisionScenarioRevision.create([{
        userId: req.user.userId, scenarioId: created._id,
        revision: 1, payload, inputHash: hash(payload),
      }], { session });
      return created.toObject();
    });
    res.status(201).json({ scenario: scenarioDto(doc), replayed: false });
  }));

  router.get('/scenarios', handleInput(async (req, res) => {
    const scenarios = await DecisionScenario.find({ userId: req.user.userId })
      .sort({ createdAt: -1 }).limit(50).lean();
    res.json({ scenarios: scenarios.map(scenarioDto), maxReturned: 50 });
  }));

  router.get('/scenarios/:id', handleInput(async (req, res) => {
    const scenario = await ownedScenario(req);
    const revision = await DecisionScenarioRevision.findOne({
      userId: req.user.userId, scenarioId: scenario._id, revision: scenario.revision,
    }).lean();
    if (!revision || revision.inputHash !== hash(revision.payload)) {
      fail(503, 'DECISION_STATE_INCOMPLETE', 'Stored scenario revision failed its integrity check.');
    }
    res.json({ scenario: scenarioDto(scenario), payload: revision.payload, inputHash: revision.inputHash });
  }));

  router.patch('/scenarios/:id', handleInput(async (req, res) => {
    const first = await ownedScenario(req);
    const payload = normalizeScenario(req.body, first.scenarioType, true);
    const current = await resolveProfile({ userId: req.user.userId, requireRecommendation: false });
    assertProfile(current, first);
    compute(current, payload);
    const updated = await transaction(async session => {
      const currentScenario = await ownedScenario(req, session);
      if (currentScenario.revision !== req.body.expectedRevision) {
        fail(409, 'DECISION_REVISION_CONFLICT', 'Scenario was changed by another request.');
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
      await DecisionScenarioRevision.create([{
        userId: req.user.userId, scenarioId: currentScenario._id,
        revision: next.revision, payload, inputHash: hash(payload),
      }], { session });
      return next;
    });
    res.json({ scenario: scenarioDto(updated) });
  }));

  router.post('/scenarios/:id/evaluate', handleInput(async (req, res) => {
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
      if (!originalRevision || originalRevision.inputHash !== hash(originalRevision.payload)) {
        fail(503, 'DECISION_STATE_INCOMPLETE', 'Stored scenario revision cannot be verified.');
      }
      if (prior.inputHash !== originalRevision.inputHash) {
        fail(409, 'IDEMPOTENCY_PAYLOAD_CONFLICT', 'Stored report input does not match the requested revision.');
      }
      const fresh = await resolveProfile({ userId: req.user.userId, requireRecommendation: false });
      return res.status(200).json({ run: reportDto(prior, fresh), replayed: true });
    }
    if (first.revision !== req.body.expectedRevision) {
      fail(409, 'DECISION_REVISION_CONFLICT', 'Scenario revision changed. Refresh before evaluating.');
    }
    const revision = await DecisionScenarioRevision.findOne({
      userId: req.user.userId, scenarioId: first._id, revision: first.revision,
    }).lean();
    if (!revision || revision.inputHash !== hash(revision.payload)) {
      fail(503, 'DECISION_STATE_INCOMPLETE', 'Decision revision integrity check failed.');
    }
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
      const [created] = await DecisionRun.create([{
        userId: req.user.userId, scenarioId: first._id, revision: first.revision,
        profileId: first.profileId, profileStateRevision: first.profileStateRevision,
        profileVersion: first.profileVersion, profileFinancialFence: first.profileFinancialFence,
        runKeyHash: key, inputHash: revision.inputHash, result,
      }], { session });
      const head = await DecisionScenario.findOneAndUpdate({
        ...own(req, first._id), revision: first.revision, runGeneration: first.runGeneration,
      }, { $set: { lastRunId: created._id }, $inc: { runGeneration: 1 } },
      { session, new: true }).lean();
      if (!head) fail(409, 'DECISION_REVISION_CONFLICT', 'Concurrent scenario evaluation detected.');
      return created.toObject();
    });
    // Re-resolve after commit: a parallel profile update must never yield a
    // newly published report falsely labeled CURRENT.
    const afterCommit = await resolveProfile({ userId: req.user.userId, requireRecommendation: false });
    res.status(201).json({ run: reportDto(run, afterCommit), replayed: false });
  }));

  router.get('/runs/:id', handleInput(async (req, res) => {
    const run = await DecisionRun.findOne(own(req, ensureId(req.params.id))).lean();
    if (!run) fail(404, 'DECISION_RUN_NOT_FOUND', 'Decision report not found.');
    const current = await resolveProfile({ userId: req.user.userId, requireRecommendation: false });
    res.json({ run: reportDto(run, current) });
  }));

  router.delete('/scenarios/:id', handleInput(async (req, res) => {
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
      return identity(scenario._id);
    });
    res.json({ deleted: true, scenarioId: deleted });
  }));

  return router;
}

export default createDecisionsRouter();
