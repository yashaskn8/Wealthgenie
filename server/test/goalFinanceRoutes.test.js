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
import User from '../models/User.js';

const secret = 'goal-finance-integration-test-jwt-secret';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ||= secret;

test('goal-only finance APIs enforce ownership, optimistic versions and deterministic scenarios', async () => {
  await setupTestDatabase({ requireReplicaSet: true });
  try {
    await GoalBudget.collection.createIndex({ userId: 1, month: 1 }, {
      unique: true, name: 'goal_budget_owner_month_unique',
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
      const endpoint = `${base}/api/goals/finance/budget/2026-10`;
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

      const { response: analyzed, body: vehicle } = await jsonRequest(`${base}/api/goals/finance/vehicle/2026-10`, {
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

      const { response: projected, body: projection } = await jsonRequest(`${base}/api/goals/finance/projection`, {
        method: 'POST', headers: authA,
        body: JSON.stringify({
          currentSavings: 10000, monthlyContribution: 1000, years: 1,
          annualReturnAssumption: 0, annualInflationAssumption: 0,
        }),
      });
      assert.equal(projected.status, 200);
      assert.equal(projection.projection.futureNominal, 22000);
    });
  } finally {
    await teardownTestDatabase();
  }
});
