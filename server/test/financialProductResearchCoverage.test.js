import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  validateIssuerResearchBatch, buildFinancial250ResearchCoverage,
} from '../scripts/generateFinancialProductResearchCoverage.js';

const batch = JSON.parse(readFileSync(
  new URL('../data/qualificationPilots/issuerIndexFunds2026-11-01.json', import.meta.url), 'utf8',
));
const mutate = fn => { const copy = structuredClone(batch); fn(copy); return copy; };

describe('250-family actual-product research workflow keeps trust boundaries', () => {
  it('covers every catalog family but never claims research is a recommendation', () => {
    const result = buildFinancial250ResearchCoverage();
    assert.equal(result.familyCount, 250);
    assert.equal(result.researchSlotCapacity, 750);
    assert.equal(result.researchedFamilyCount, 18);
    assert.equal(result.issuerIdentitiesResearched, 53);
    assert.equal(result.duplicateIssuerProductsWithinCategory, 0);
    assert.equal(result.productionQualifiedFamilies, 'NOT_MEASURED');
    assert.equal(result.personalizedTopThreeComputed, false);
    assert.equal(result.afterTaxProductReturnsComputed, false);
    assert.equal(result.families.length, 250);
    assert.equal(result.families.reduce((sum, f) => sum + f.researchOnlyCandidates.length, 0), 53);
    assert.ok(result.families.every(f => f.productionComparisonReady === false));
    assert.ok(result.families.every(f => f.qualifiedProductCount === null));
    const familiesWithThree = result.families.filter(f => f.researchOnlyCandidates.length === 3);
    assert.equal(familiesWithThree.length, 17);
    assert.equal(result.families.filter(f => f.researchOnlyCandidates.length === 2).length, 1);
    const byId = new Map(result.families.map(f => [f.familyId, f]));
    assert.deepEqual(
      byId.get('catalog_2026_index_nifty100_equal').researchOnlyCandidates.map(x => x.issuer),
      ['HDFC Mutual Fund', 'Kotak Mutual Fund', 'Sundaram Mutual Fund'],
    );
    assert.ok(byId.get('catalog_2026_etf_nifty50_equal').researchOnlyCandidates.every(
      x => x.schemeName.toLowerCase().includes('etf'),
    ));
    for (const f of result.families) for (const candidate of f.researchOnlyCandidates) {
      assert.equal(candidate.eligibleForRecommendation, false);
      assert.equal(candidate.hasCommercialDisplayPermission, false);
      assert.equal(candidate.marketObservationQualified, false);
      assert.equal(candidate.taxOutcomeVerified, false);
    }
  });

  it('rejects malicious or redirected source domains and injected rights claims', () => {
    const impostor = mutate(b => {
      b.families[0].researchCandidates[0].officialSourceUrl =
        'https://www.utimf.com.attacker.test/fake-fund';
    });
    assert.throws(() => validateIssuerResearchBatch(impostor), /ISSUER_URL_NOT_AUTHENTICATED/);
    const injection = mutate(b => {
      b.families[0].researchCandidates[0].productionRecommendationEligible = true;
    });
    assert.throws(() => validateIssuerResearchBatch(injection), /RESEARCH_CANDIDATE_INVALID/);
    const explicitApproval = mutate(b => { b.qualificationsGranted = 6; });
    assert.throws(() => validateIssuerResearchBatch(explicitApproval), /RESEARCH_OR_QUEUE_INVALID/);
  });

  it('rejects cross-benchmark products even in the same asset category', () => {
    const mismatch = mutate(b => {
      b.families[0].researchCandidates[0].schemeName = 'UTI Nifty 100 Index Fund';
    });
    assert.throws(() => validateIssuerResearchBatch(mismatch), /SCHEME_NOT_IN_FAMILY/);
    const benchmark = mutate(b => { b.families[1].benchmark = 'Nifty Next 50 TRI'; });
    assert.throws(() => validateIssuerResearchBatch(benchmark), /FAMILY_INDEX_MISMATCH/);
  });

  it('rejects duplicate issuer, family and fabricated additional slot', () => {
    const duplicated = mutate(b => {
      b.families[0].researchCandidates[1].issuer = 'UTI Mutual Fund';
      b.families[0].researchCandidates[1].issuerDomain = 'www.utimf.com';
      b.families[0].researchCandidates[1].officialSourceUrl =
        'https://www.utimf.com/mutual-funds/uti-nifty-next-50-index-fund';
    });
    assert.throws(() => validateIssuerResearchBatch(duplicated), /RESEARCH_CANDIDATE_INVALID/);
    const duplicateSlot = mutate(b => { b.families[1].researchCandidates[1].researchSlot = 1; });
    assert.throws(() => validateIssuerResearchBatch(duplicateSlot), /RESEARCH_CANDIDATE_INVALID/);
    const extra = mutate(b => { b.families.push(structuredClone(b.families[0])); });
    assert.throws(() => validateIssuerResearchBatch(extra), /FAMILY_OR_BENCHMARK_MISMATCH/);
  });
});
