import { canonicalSha256 } from '../../utils/canonicalJson.js';
import { GENIEPROOF_PPF_PARSER_VERSION, GENIEPROOF_PPF_RATE_RULE_VERSION } from './genieProofEvidenceContract.js';

// This is a registry candidate only. Its rights state is deliberately blocked;
// adding a catalog row never qualifies a source or enables a financial finding.
const indiaPostPpfCandidate = Object.freeze({
  sourceId: 'india-post-small-savings',
  revision: 1,
  publisher: 'Department of Posts, Government of India',
  officialIdentity: 'India Post small savings schemes page; PPF row and effective interval require exact parser binding.',
  endpoint: 'https://www.indiapost.gov.in/banking-services/savings',
  sourceClass: 'QUARTERLY_OFFICIAL_RATE',
  productIds: ['government:india-post:ppf'],
  claimTypes: ['CURRENT_NOMINAL_RATE'],
  expectedMimeTypes: ['text/html', 'application/javascript', 'text/javascript'],
  parserVersion: GENIEPROOF_PPF_PARSER_VERSION,
  ruleVersion: GENIEPROOF_PPF_RATE_RULE_VERSION,
  lineage: [],
  qualificationStatus: 'BLOCKED_REUSE_RIGHTS',
  reusePermissionStatus: 'BLOCKED',
  reviewRecord: { reviewedAt: null, reference: null, scope: null },
  supersedes: null,
  revocationReasonCode: null,
});

export const GENIEPROOF_SOURCE_CATALOG_CANDIDATES = Object.freeze([
  Object.freeze({
    ...indiaPostPpfCandidate,
    definitionHash: canonicalSha256(indiaPostPpfCandidate),
  }),
]);
