import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCashRiskEvent, cashReconfirmationEvent, cashEventKey } from '../services/coverageRiskPolicy.js';
const userId = '507f191e810c19729de860ea';
const input = { asOfDate: '2026-10-23', openingCashPaise: 10_000, completenessConfirmed: true };
const short = { status: 'SHORTFALL_IN_ENTERED_PLAN', baseline: {
  earliestShortfall: { date: '2026-10-30' },
} };
const clear = { status: 'NO_SHORTFALL_IN_ENTERED_PLAN', baseline: { earliestShortfall: null } };
test('cash risk event only opens on a real shortfall transition', () => {
  const first = evaluateCashRiskEvent({ userId, revision: 1, input, result: short });
  assert.equal(first.kind, 'SHORTFALL_DETECTED');
  assert.equal(first.dueDate, '2026-10-30');
  assert.match(first.eventKey, /^[a-f0-9]{64}$/);
  assert.equal(evaluateCashRiskEvent({ userId, revision: 2, input, result: short,
    priorResult: short }), null);
  assert.equal(evaluateCashRiskEvent({ userId, revision: 2, input, result: clear,
    priorResult: clear }), null);
  const resolved = evaluateCashRiskEvent({ userId, revision: 3, input, result: clear,
    priorResult: short });
  assert.equal(resolved.kind, 'SHORTFALL_RESOLVED');
});
test('date change produces one meaningful risk event without storing amounts', () => {
  const newer = { ...short, baseline: { earliestShortfall: { date: '2026-11-01' } } };
  const e = evaluateCashRiskEvent({ userId, revision: 2, input, result: newer, priorResult: short });
  assert.equal(e.kind, 'SHORTFALL_CHANGED');
  assert.equal(e.dueDate, '2026-11-01');
  assert.equal(JSON.stringify(e).includes('10_000'), false);
});
test('missing cash, unknown policy status and unconfirmed data suppress alerts', () => {
  assert.equal(evaluateCashRiskEvent({ userId, revision: 1, input: { ...input, openingCashPaise: null },
    result: short }), null);
  assert.equal(evaluateCashRiskEvent({ userId, revision: 1,
    input: { ...input, completenessConfirmed: false }, result: short }), null);
  assert.equal(evaluateCashRiskEvent({ userId, revision: 1, input,
    result: { status: 'CANNOT_CALCULATE', baseline: null } }), null);
});
test('stale cash generates a stable, deduplicatable reconfirmation identity', () => {
  const a = cashReconfirmationEvent({ userId, revision: 7, sourceAsOfDate: '2026-10-23',
    today: '2026-10-24' });
  const b = cashReconfirmationEvent({ userId, revision: 7, sourceAsOfDate: '2026-10-23',
    today: '2026-11-01' });
  assert.deepEqual(a, b);
  assert.equal(cashReconfirmationEvent({ userId, revision: 7, sourceAsOfDate: '2026-10-23',
    today: '2026-10-23' }), null);
  assert.notEqual(cashEventKey({ userId, revision: 7, kind: a.kind, sourceAsOfDate: a.sourceAsOfDate }),
    cashEventKey({ userId, revision: 8, kind: a.kind, sourceAsOfDate: a.sourceAsOfDate }));
});


test('a changed minimum cash deficit on the same date also generates an in-app risk change', () => {
  const previous = { ...short, baseline: {
    ...short.baseline, minWithinDayPaise: -100_00,
  } };
  const worsened = { ...short, baseline: {
    ...short.baseline, minWithinDayPaise: -200_00,
  } };
  const e = evaluateCashRiskEvent({ userId, revision: 3, input,
    result: worsened, priorResult: previous });
  assert.equal(e.kind, 'SHORTFALL_CHANGED');
  assert.equal(e.dueDate, '2026-10-30');
  assert.equal('amountPaise' in e, false);
});
