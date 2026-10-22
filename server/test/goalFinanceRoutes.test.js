import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { setupTestDatabase, teardownTestDatabase } from './helpers/mongoTestHelper.js';
import { withServer, jsonRequest } from '../test-utils/httpTestUtils.js';
import { enforceJsonContentType } from '../middleware/contentType.js';
import { errorHandler } from '../middleware/errorHandler.js';
import goalFinanceRoutes from '../routes/goalFinance.js';
import GoalBudget from '../models/GoalBudget.js';
import GoalSpecification from '../models/GoalSpecification.js';
import User from '../models/User.js';

const currentIndianMonth = () => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit',
  }).formatToParts(new Date());
  const part = type => parts.find(p => p.type === type)?.value;
  return `${part('year')}-${part('month')}`;
};
const secret = 'goal-finance-integration-test-jwt-secret';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ||= secret;

test('goal-only finance APIs enforce ownership, optimistic versions and deterministic scenarios', async () => {
  await setupTestDatabase({ requireReplicaSet: true });
  try {
    await GoalBudget.collection.createIndex({ userId: 1, month: 1 }, {
      unique: true, name: 'goal_budget_owner_month_unique',
    });
    await GoalSpecification.collection.createIndex({ userId: 1, creationKey: 1 }, {
      unique: true, name: 'goal_spec_owner_create_key_unique',
    });
    const userA = new mongoose.Types.ObjectId();
    const userB = new mongoose.Types.ObjectId();
    await User.create([
      { _id: userA, name: 'Goal Finance Test A', email: `goal-a-${crypto.randomUUID()}@example.test`, passwordHash: 'test-hash' },
      { _id: userB, name: 'Goal Finance Test B', email: `goal-b-${crypto.randomUUID()}@example.test`, passwordHash: 'test-hash' },
    ]);
    const app = express();
    app.use(enforceJsonContentType);
    app.use(express.json());
    app.use('/api/goals/finance', goalFinanceRoutes);
    app.use(errorHandler);
    const token = id => jwt.sign({ userId: String(id), jti: crypto.randomUUID() }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const authA = { Authorization: `Bearer ${token(userA)}` };
    const authB = { Authorization: `Bearer ${token(userB)}` };
    const budget = {
      expectedVersion: 0, monthlyIncome: 60000, expensesComplete: true,
      protectedMonthlyContributions: 4000,
      expenses: [
        { category: 'housing', frequency: 'recurring', amount: 18000 },
        { category: 'existing_emi', frequency: 'recurring', amount: 12000 },
        { category: 'groceries', frequency: 'recurring', amount: 8000 },
      ],
    };
    await withServer(app, async base => {
      const endpoint = `${base}/api/goals/finance/budget/${currentIndianMonth()}`;
      const { response: mismatchedFunding } = await jsonRequest(
        `${base}/api/goals/finance/funding/2020-01`, { headers: authA });
      assert.equal(mismatchedFunding.status, 409);
      const { response: mismatchedVehicle } = await jsonRequest(
        `${base}/api/goals/finance/vehicle/2020-01`, {
          method: 'POST', headers: authA, body: JSON.stringify({
            price: 200000, downPayment: 100000, upfrontFees: 9000, monthlyOwnershipCost: 2500,
            annualInterestRate: 9, tenureMonths: 36, emergencyCash: 150000, emergencyFloor: 20000,
          }),
        });
      assert.equal(mismatchedVehicle.status, 409);
      const unauthenticated = await jsonRequest(endpoint);
      assert.equal(unauthenticated.response.status, 401);

      const { response: created, body: createBody } = await jsonRequest(endpoint, {
        method: 'PUT', headers: authA, body: JSON.stringify(budget),
      });
      assert.equal(created.status, 200);
      assert.equal(createBody.budget.version, 1);
      assert.equal(createBody.summary.recurringSurplus, 18000);

      const { response: raced } = await jsonRequest(endpoint, {
        method: 'PUT', headers: authA, body: JSON.stringify(budget),
      });
      assert.equal(raced.status, 409);

      const { body: otherBudget } = await jsonRequest(endpoint, { headers: authB });
      assert.equal(otherBudget.budget.version, 0);
      assert.equal(otherBudget.budget.monthlyIncome, null);

      const { response: invalid } = await jsonRequest(endpoint, {
        method: 'PUT', headers: authA,
        body: JSON.stringify({ ...budget, expectedVersion: 1, expenses: [{ category: 'invalid', frequency: 'recurring', amount: 200 }] }),
      });
      assert.equal(invalid.status, 400);

      const { response: updated, body: updatedBody } = await jsonRequest(endpoint, {
        method: 'PUT', headers: authA, body: JSON.stringify({ ...budget, expectedVersion: 1, monthlyIncome: 61000 }),
      });
      assert.equal(updated.status, 200);
      assert.equal(updatedBody.budget.version, 2);

      const { response: analyzed, body: vehicle } = await jsonRequest(`${base}/api/goals/finance/vehicle/${currentIndianMonth()}`, {
        method: 'POST', headers: authA,
        body: JSON.stringify({
          price: 900000, downPayment: 200000, upfrontFees: 15000, monthlyOwnershipCost: 4500,
          annualInterestRate: 10, tenureMonths: 60, emergencyCash: 400000, emergencyFloor: 150000,
          alternatives: [{ label: 'Cheaper quoted vehicle', price: 500000, downPayment: 200000,
            upfrontFees: 15000, monthlyOwnershipCost: 2500 }],
        }),
      });
      assert.equal(analyzed.status, 200);
      assert.equal(vehicle.livePriceVerified, false);
      assert.equal(vehicle.alternatives.length, 1);
      assert.ok(vehicle.alternatives[0].assessment.loan.monthlyEmi < vehicle.primary.loan.monthlyEmi);

      const { response: independentQuoteRes, body: independentQuote } = await jsonRequest(
        `${base}/api/goals/finance/vehicle/${currentIndianMonth()}`, {
          method: 'POST', headers: authA, body: JSON.stringify({
            price: 900000, downPayment: 200000, upfrontFees: 15000,
            monthlyOwnershipCost: 4500, annualInterestRate: 10, tenureMonths: 60,
            emergencyCash: 400000, emergencyFloor: 150000,
            alternatives: [{
              label: 'Different lender', price: 500000, downPayment: 200000,
              upfrontFees: 15000, monthlyOwnershipCost: 2500,
              annualInterestRate: 2, tenureMonths: 12,
            }],
          }),
        });
      assert.equal(independentQuoteRes.status, 200);
      assert.equal(independentQuote.primary.loan.annualInterestRate, 10);
      assert.equal(independentQuote.alternatives[0].assessment.loan.annualInterestRate, 2);
      assert.equal(independentQuote.alternatives[0].assessment.loan.tenureMonths, 12);
      assert.equal(independentQuote.alternatives[0].annualInterestRateSource, 'USER_ALTERNATIVE_QUOTE');
      assert.equal(independentQuote.alternatives[0].tenureSource, 'USER_ALTERNATIVE_QUOTE');
      assert.equal(vehicle.alternatives[0].annualInterestRateSource, 'SHARED_PRIMARY_ASSUMPTION');


      const { response: projected, body: projection } = await jsonRequest(`${base}/api/goals/finance/projection`, {
        method: 'POST', headers: authA,
        body: JSON.stringify({
          currentSavings: 10000, monthlyContribution: 1000, years: 1,
          annualReturnAssumption: 0, annualInflationAssumption: 0,
        }),
      });
      assert.equal(projected.status, 200);
      assert.equal(projection.projection.futureNominal, 22000);

      // Financially invalid cross-field inputs must return a typed 422 error,
      // never a 500 that hides an invalid down payment or overflow.
      const vehicleEndpoint = `${base}/api/goals/finance/vehicle/${currentIndianMonth()}`;
      const validQuote = {
        price: 400000, downPayment: 200000, upfrontFees: 9000,
        monthlyOwnershipCost: 2000, annualInterestRate: 10,
        tenureMonths: 60, emergencyCash: 300000, emergencyFloor: 20000,
      };
      const { response: invalidDownPayment, body: invalidDownPaymentBody } =
        await jsonRequest(vehicleEndpoint, {
          method: 'POST', headers: authA,
          body: JSON.stringify({ ...validQuote, downPayment: 450000 }),
        });
      assert.equal(invalidDownPayment.status, 422);
      assert.equal(invalidDownPaymentBody.code, 'GOAL_VEHICLE_SCENARIO_INVALID');
      const { response: invalidAlternative } = await jsonRequest(vehicleEndpoint, {
        method: 'POST', headers: authA,
        body: JSON.stringify({ ...validQuote, alternatives: [{
          label: 'Invalid dealer quote', price: 200000, downPayment: 250000,
          upfrontFees: 9000, monthlyOwnershipCost: 2000,
        }] }),
      });
      assert.equal(invalidAlternative.status, 422);
      const { response: projectionOverflow, body: projectionOverflowBody } =
        await jsonRequest(`${base}/api/goals/finance/projection`, {
          method: 'POST', headers: authA,
          body: JSON.stringify({
            currentSavings: 1_000_000_000, monthlyContribution: 1_000_000_000,
            years: 50, annualReturnAssumption: 100, annualInflationAssumption: 0,
          }),
        });
      assert.equal(projectionOverflow.status, 422);
      assert.equal(projectionOverflowBody.code, 'GOAL_PROJECTION_OUT_OF_RANGE');

      const typedPayload = {
        kind: 'vehicle', name: 'Lower cost commuter', targetAmount: 500000,
        currentSavings: 50000, targetDate: '2028-12-20', priority: 'High',
        annualPriceInflationPct: 3, notes: 'Price is illustrative and user-entered',
      };
      const specsEndpoint = `${base}/api/goals/finance/specifications`;
      const createHeaders = { ...authA, 'Idempotency-Key': 'goals-spec-test-key-0001' };
      const { response: specCreated, body: createdSpec } = await jsonRequest(specsEndpoint, {
        method: 'POST', headers: createHeaders, body: JSON.stringify(typedPayload),
      });
      assert.equal(specCreated.status, 201);
      assert.equal(createdSpec.specification.version, 1);
      const { response: replayRes, body: sameSpec } = await jsonRequest(specsEndpoint, {
        method: 'POST', headers: createHeaders, body: JSON.stringify(typedPayload),
      });
      assert.equal(replayRes.status, 200);
      assert.equal(sameSpec.replay, true);
      assert.equal(sameSpec.specification.id, createdSpec.specification.id);
      const { response: replayConflict } = await jsonRequest(specsEndpoint, {
        method: 'POST', headers: createHeaders,
        body: JSON.stringify({ ...typedPayload, name: 'Different purchase' }),
      });
      assert.equal(replayConflict.status, 409);
      assert.equal(await GoalSpecification.countDocuments({ userId: userA }), 1);

      assert.ok(createdSpec.specification.plan.monthlyNeededWithoutReturns > 0);
      const { body: otherSpecs } = await jsonRequest(specsEndpoint, { headers: authB });
      assert.equal(otherSpecs.specifications.length, 0);
      // The car appears affordable on the budget alone, but not after this
      // typed goal's monthly savings requirement consumes the shared envelope.
      const constrainedVehicle = {
        price: 300000, downPayment: 200000, upfrontFees: 15000,
        monthlyOwnershipCost: 2500, annualInterestRate: 10,
        tenureMonths: 60, emergencyCash: 400000, emergencyFloor: 150000,
      };
      const { response: goalAwareRes, body: goalAware } = await jsonRequest(
        `${base}/api/goals/finance/vehicle/${currentIndianMonth()}`, {
          method: 'POST', headers: authA, body: JSON.stringify(constrainedVehicle),
        });
      assert.equal(goalAwareRes.status, 200);
      assert.ok(goalAware.primary.requiredMonthlyGoalContributions > 0);
      assert.equal(goalAware.primary.status, 'BUDGET_SHORTFALL');
      assert.ok(goalAware.primary.reasons.includes('GOALS_AND_PURCHASE_EXCEED_SAVINGS'));
      const typedId = createdSpec.specification.id;
      const { response: typedUpdated, body: updatedSpec } = await jsonRequest(`${specsEndpoint}/${typedId}`, {
        method: 'PUT', headers: authA,
        body: JSON.stringify({ ...typedPayload, expectedVersion: 1, priority: 'Critical' }),
      });
      assert.equal(typedUpdated.status, 200);
      assert.equal(updatedSpec.specification.version, 2);
      const { response: specStale } = await jsonRequest(`${specsEndpoint}/${typedId}`, {
        method: 'PUT', headers: authA, body: JSON.stringify({ ...typedPayload, expectedVersion: 1 }),
      });
      assert.equal(specStale.status, 409);
      const { response: specBadDate } = await jsonRequest(specsEndpoint, {
        method: 'POST', headers: authA, body: JSON.stringify({ ...typedPayload, targetDate: '2030-02-30' }),
      });
      assert.equal(specBadDate.status, 400);
      const { response: specBadHorizon } = await jsonRequest(specsEndpoint, {
        method: 'POST', headers: authA, body: JSON.stringify({ ...typedPayload, targetDate: '2100-10-20' }),
      });
      assert.equal(specBadHorizon.status, 400);
      // Inject a malformed historical document without Mongoose casting,
      // then require the owned list to remain available and fail closed.
      await GoalSpecification.collection.updateOne({ _id: new mongoose.Types.ObjectId(typedId) },
        { $set: { targetDate: 'legacy-invalid-date' } });
      const { response: corruptStatus, body: corruptList } = await jsonRequest(specsEndpoint, { headers: authA });
      assert.equal(corruptStatus.status, 200);
      const corruptSpec = corruptList.specifications.find(s => s.id === typedId);
      assert.equal(corruptSpec.targetDate, null);
      assert.equal(corruptSpec.plan.status, 'DATA_INSUFFICIENT');
      await GoalSpecification.collection.updateOne({ _id: new mongoose.Types.ObjectId(typedId) },
        { $set: { targetDate: new Date('2028-12-20T00:00:00.000Z') } });
      const { response: specOtherDelete } = await jsonRequest(`${specsEndpoint}/${typedId}`, {
        method: 'DELETE', headers: { ...authB, 'If-Match': '"2"' },
      });
      assert.equal(specOtherDelete.status, 409);
      const { response: specDeleted } = await jsonRequest(`${specsEndpoint}/${typedId}`, {
        method: 'DELETE', headers: { ...authA, 'If-Match': '"2"' },
      });
      assert.equal(specDeleted.status, 200);
    });
  } finally {
    await teardownTestDatabase();
  }
});
