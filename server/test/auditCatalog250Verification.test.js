import test from 'node:test';
import assert from 'node:assert/strict';
import { investmentDatabase } from '../data/investmentDatabase.js';
import { readFileSync } from 'node:fs';
import { buildCatalog250Verification, catalog250VerificationCsv } from '../scripts/auditCatalog250Verification.js';
import { buildTopThreeProductEvidenceQueue } from '../scripts/generateFinancialTopThreeEvidenceQueue.js';
const { entries } = JSON.parse(readFileSync(
  new URL('../data/investmentUniverseExtensions2026.json', import.meta.url), 'utf8'
));
test('each of all 250 unique family IDs has exactly 3 empty evidence slots', () => {
  const report = buildCatalog250Verification();
  assert.equal(report.totalFamilies, 250);
  assert.equal(report.legacyFamilies, 155);
  assert.equal(report.extensionFamilies, 95);
  assert.equal(report.reviewSlotsChecked, 750);
  assert.equal(report.reviewedProductIdentitySlotsPopulated, 0);
  assert.equal(report.productionQualifiedFamilies, 'NOT_MEASURED');
  assert.equal(new Set(report.families.map(x => x.familyId)).size, 250);
  assert.equal(new Set(report.families.map(x => x.name.toLowerCase())).size, 250);
  assert.ok(report.families.every(x=>x.minimumActualQualifiedProductsNeeded === 2
    && x.productionStatus === 'NOT_VERIFIED_AS_TWO_CURRENT_SUITABLE_ACTUAL_PRODUCTS'
    && x.currentProductionQualifiedProducts === null));
  const csv = catalog250VerificationCsv(report).trim().split('\n');
  assert.equal(csv.length, 251);
});
test('missing external identity, rights or invalid extension metadata cannot be approved', () => {
  assert.throws(()=>buildCatalog250Verification({extensions:entries.slice(1)}), /EXPECTED_155/);
  const clone = entries.map((x,i)=>i ? x : {...x, recommendationEligible:true});
  assert.throws(()=>buildCatalog250Verification({extensions:clone}), /EXTENSION_EVIDENCE_CLAIM_INCONSISTENT/);
  const dupe = [...investmentDatabase];
  dupe[1]={...dupe[1],id:dupe[0].id};
  assert.throws(()=>buildCatalog250Verification({legacy:dupe}), /FINANCIAL_FAMILY_INVENTORY_DUPLICATE_OR_INVALID|INVALID_OR_DUPLICATE_FAMILY_ID/);
});

test('source audit rejects forged, promoted, extra, or misbound review slot evidence', () => {
  const base = buildTopThreeProductEvidenceQueue();
  assert.doesNotThrow(() => buildCatalog250Verification({ slots: base }));
  const rejects = (field, value = 'FORGED') => {
    const slots = base.map((row, index) =>
      index === 0 ? { ...row, [field]: value } : row);
    assert.throws(() => buildCatalog250Verification({ slots }),
      /UNAPPROVED_PRODUCT_EVIDENCE_IN_REVIEW_QUEUE|FAMILY_REVIEW_SLOTS_NOT_COMPLETE/,
      field);
  };
  for (const field of [
    'actualProductId', 'issuerName', 'issuerOfficialDocumentUrl',
    'officialProductTermsUrl', 'riskEvidenceUrl', 'taxEvidenceUrl',
    'providerSourceId', 'providerInstrumentId', 'providerApprovalReference',
    'independentReviewer', 'approvedAt', 'expiresAt',
  ]) rejects(field);
  rejects('status', 'ACTIVE');
  rejects('familyName', 'MISBOUND_FAMILY');
  rejects('category', 'MISBOUND_CATEGORY');
  rejects('categoryEvidenceUrl', 'https://example.org/misbound');
  rejects('unreviewedExtraField');
});
