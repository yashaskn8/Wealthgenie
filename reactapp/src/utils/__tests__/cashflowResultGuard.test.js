import { describe, expect, it } from 'vitest';
import { mayDisplayContractualProceeds } from '../cashflowResultGuard';

function valid() {
  const principal = 10000, interest = 400;
  return {
    canonicalProductId: 'government:india-post:post-office-td-2y',
    cashflowIllustration: {
      status: 'CALCULATED',
      canonicalProductId: 'government:india-post:post-office-td-2y',
      cashflowType: 'ANNUAL_PAYOUT',
      tenureMonths: 24,
      principal,
      grossTotalProceeds: principal + 2 * interest,
      grossMaturityProceeds: principal + interest,
      postTaxProceeds: null,
      cashflowLedger: {
        status: 'RECONCILED',currency: 'INR',precision: 'INTEGER_PAISE',
        totalReceiptsPaise: 1080000, grossGainPaise: 80000,
        events: [
          { kind: 'SUBSCRIPTION',monthOffset: 0,amountPaise: -1000000 },
          { kind: 'INTEREST_PAYOUT',monthOffset: 12,amountPaise: 40000 },
          { kind: 'INTEREST_PAYOUT',monthOffset: 24,amountPaise: 40000 },
          { kind: 'PRINCIPAL_REDEMPTION',monthOffset: 24,amountPaise: 1000000 },
        ],
      },
    },
  };
}
describe('Where to Invest contractual result display integrity', () => {
  it('admits a reconciled official-contract DTO', () => {
    expect(mayDisplayContractualProceeds(valid())).toBe(true);
  });
  it('never shows a market-priced not-applicable instrument as a contract', () => {
    const row=valid();
    row.cashflowIllustration.status='NOT_APPLICABLE';
    expect(mayDisplayContractualProceeds(row)).toBe(false);
  });
  it('blocks wrong product, missing ledger, unsupported currency or absent tax status', () => {
    for (const fn of [
      r => { r.canonicalProductId='another-product'; },
      r => { r.cashflowIllustration.cashflowLedger=null; },
      r => { r.cashflowIllustration.cashflowLedger.currency='USD'; },
      r => { r.cashflowIllustration.cashflowLedger.precision='FLOAT'; },
      r => { r.cashflowIllustration.postTaxProceeds=0; },
    ]) { const r=valid();fn(r);expect(mayDisplayContractualProceeds(r)).toBe(false); }
  });
  it('blocks forged totals, hidden negative transfers, missing coupons and fractional-paisa amounts', () => {
    for(const fn of [
      r=>{r.cashflowIllustration.grossTotalProceeds=15000;},
      r=>{r.cashflowIllustration.grossTotalProceeds=10800.001;},
      r=>{r.cashflowIllustration.cashflowLedger.grossGainPaise=1;},
      r=>{r.cashflowIllustration.cashflowLedger.events.pop();},
      r=>{r.cashflowIllustration.cashflowLedger.events[1].amountPaise=-40000;},
      r=>{r.cashflowIllustration.cashflowLedger.events[0].amountPaise=1000000;},
    ]) {const r=valid();fn(r);expect(mayDisplayContractualProceeds(r)).toBe(false);}
  });
});
