/**
 * Source-bound contractual payment reconciliation, not investor tax accounting.
 * Month offsets are relative contract periods, NEVER represented as legal
 * settlement dates. Money arithmetic uses safe integer paise throughout.
 */
export const CONTRACT_LEDGER_VERSION = 'contract-ledger-1.0.0';
function toPaise(n, field) {
  if (!Number.isFinite(n) || n < 0 || n > Number.MAX_SAFE_INTEGER / 100)
    throw new RangeError(`${field} must be a supported finite INR amount`);
  // Do not silently round sub-paisa numbers from upstream financial models.
  // Parsing Number's shortest decimal representation avoids binary-float
  // multiplication artifacts such as 0.29 * 100.
  const match = /^(0|[1-9][0-9]*)(?:[.]([0-9]{1,2}))?$/.exec(String(n));
  if (!match) throw new RangeError(`${field} must have at most two decimal places`);
  const p = Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
  if (!Number.isSafeInteger(p)) throw new RangeError(`${field} exceeds paise precision`);
  return p;
}
export function buildContractualCashflowLedger({
  principal, tenureMonths, cashflowType, annualPayouts = [],
  grossMaturityProceeds, grossTotalProceeds,
}) {
  if (!Number.isInteger(tenureMonths) || tenureMonths < 1 || tenureMonths > 360)
    throw new RangeError('invalid contractual tenure');
  if (!['MATURITY_COMPOUND','SOURCE_TENOR_DOUBLE','ANNUAL_PAYOUT'].includes(cashflowType))
    throw new RangeError('unsupported contractual model');
  if (!Array.isArray(annualPayouts)) throw new TypeError('invalid payout schedule');
  const opening = toPaise(principal, 'principal');
  if (!opening) throw new RangeError('principal must be positive');
  const gross = toPaise(grossTotalProceeds, 'grossTotalProceeds');
  const terminal = toPaise(grossMaturityProceeds, 'grossMaturityProceeds');
  const events = [{ id:'subscription', monthOffset:0, kind:'SUBSCRIPTION', amountPaise:-opening }];
  let couponSum = 0;
  if (cashflowType === 'ANNUAL_PAYOUT') {
    if (tenureMonths % 12 || annualPayouts.length !== tenureMonths / 12)
      throw new RangeError('annual payout schedule is incomplete');
    for (let i=0; i<annualPayouts.length; i++) {
      const coupon=annualPayouts[i], month=(i+1)*12;
      if (coupon?.month !== month) throw new RangeError('payout month mismatch');
      const paise=toPaise(coupon.annualInterestPaid, 'interest payout');
      couponSum += paise;
      if (!Number.isSafeInteger(couponSum)) throw new RangeError('coupon overflow');
      events.push({ id:`coupon:${month}`,monthOffset:month,kind:'INTEREST_PAYOUT',amountPaise:paise });
    }
    const finalCoupon=toPaise(annualPayouts.at(-1).annualInterestPaid, 'final coupon');
    if (gross !== opening+couponSum || terminal !== opening+finalCoupon)
      throw new RangeError('contractual annual payouts do not reconcile');
    events.push({ id:'principal', monthOffset:tenureMonths,
      kind:'PRINCIPAL_REDEMPTION',amountPaise:opening });
  } else {
    if (annualPayouts.length || gross !== terminal || terminal < opening)
      throw new RangeError('maturity cash flows do not reconcile');
    events.push({ id:'redemption',monthOffset:tenureMonths,
      kind:'MATURITY_REDEMPTION',amountPaise:terminal });
  }
  const receipts=events.reduce((s,event)=>s+Math.max(0,event.amountPaise),0);
  if (!Number.isSafeInteger(receipts) || receipts !== gross)
    throw new RangeError('cash flows do not reconcile to source-bound proceeds');
  return {
    version:CONTRACT_LEDGER_VERSION,status:'RECONCILED',
    currency:'INR',precision:'INTEGER_PAISE',
    timingBasis:'RELATIVE_MONTH_OFFSETS_NOT_SETTLEMENT_DATES',
    taxStatus:'REQUIRES_VERIFIED_INVESTOR_TAX_EVENTS',
    xirrStatus:'UNAVAILABLE_WITHOUT_VERIFIED_PAYMENT_DATES',
    totalReceiptsPaise:receipts,grossGainPaise:receipts-opening,events,
  };
}
