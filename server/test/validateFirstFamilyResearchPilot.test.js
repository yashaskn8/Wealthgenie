import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { validateFirstFamilyResearchPilot, PILOT_FAMILY_ID } from '../scripts/validateFirstFamilyResearchPilot.js';
import { buildCatalog250Verification } from '../scripts/auditCatalog250Verification.js';

const raw = JSON.parse(readFileSync(
  new URL('../data/qualificationPilots/bankRecurringDeposit2026-10-28.json', import.meta.url), 'utf8'
));
const at = new Date('2026-10-28T16:00:00Z');
const copy = () => structuredClone(raw);
test('first family has two distinct official issuer offering references, not two approved investments', () => {
 const outcome = validateFirstFamilyResearchPilot(copy(), {now:at});
 assert.equal(outcome.familyId,PILOT_FAMILY_ID);
 assert.equal(outcome.independentlyDocumentedIssuerOfferings,2);
 assert.equal(outcome.approvedActualInvestmentProducts,0);
 assert.equal(outcome.productionEligible,false);
 assert.equal(outcome.rightsState,'NOT_INDEPENDENTLY_VERIFIED');
 assert.equal(outcome.researchEvidenceFreshness,'RECENT_SOURCE_REVIEW');
 assert.equal(buildCatalog250Verification().totalFamilies,250);
 assert.ok(raw.candidates.every(x=>x.productionRecommendationEligible===false));
});
test('pilot source notes never become a commercial entitlement, booking or tax/suitability approval',()=>{
 const alter = (change) => {const x=copy();change(x);return x;};
 for (const changed of [
  alter(x=>x.commercialDataEntitlementVerified=true),
  alter(x=>x.actualProductsApprovedForRecommendations=2),
  alter(x=>x.independentProductReviewer='self-attestation'),
  alter(x=>x.candidates[0].issuerEntitlementVerified=true),
  alter(x=>x.candidates[1].productionRecommendationEligible=true),
  alter(x=>x.candidates[1].taxClassificationReviewComplete=true),
  alter(x=>x.candidates[0].actualRetailBookingConfirmed=true),
  alter(x=>x.candidates[0].officialRateUrl='https://fake-sbi.example/interest-rates'),
  alter(x=>x.candidates[1].publishedRatePercentPerAnnum=7.99),
  alter(x=>x.candidates[1].issuer=x.candidates[0].issuer),
  alter(x=>x.familyId='catalog_2026_bank_sweep_fd'),
 ]) {
  assert.throws(()=>validateFirstFamilyResearchPilot(changed,{now:at}), /^Error: RD_PILOT_/);
 }
});
test('HDFC standard and SMS channel minima remain separate, with official source links',()=>{
 const expected=copy().candidates.find(x=>x.issuer==='HDFC Bank Limited');
 assert.deepEqual(expected.publishedChannelMinimums.map(x=>[x.channel,x.monthlyMinimumInr]),
   [['STANDARD_RD',500],['SMS_RD',1000]]);
 assert.ok(expected.publishedChannelMinimums.every(x=>x.officialUrl.startsWith('https://www.hdfc.bank.in/')));
 const altered=copy();
 altered.candidates.find(x=>x.issuer==='HDFC Bank Limited')
   .publishedChannelMinimums[1].monthlyMinimumInr=500;
 assert.throws(()=>validateFirstFamilyResearchPilot(altered,{now:at}),/RD_PILOT_PUBLIC_BOOKING_CHANNEL_MINIMUM_MISMATCH/);
});
test('published reference facts become due for recheck without becoming a live rate',()=>{
 const p=validateFirstFamilyResearchPilot(copy(),{now:new Date('2026-11-12T00:00:00Z')});
 assert.equal(p.researchEvidenceFreshness,'RECHECK_REQUIRED');
 assert.equal(p.productionEligible,false);
});
