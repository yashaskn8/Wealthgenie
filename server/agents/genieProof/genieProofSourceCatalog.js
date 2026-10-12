import { canonicalSha256 } from '../../utils/canonicalJson.js';
import { GENIEPROOF_PPF_PARSER_VERSION, GENIEPROOF_PPF_RATE_RULE_VERSION } from './genieProofEvidenceContract.js';

// These are registry candidates only. Rights stay deliberately blocked;
// adding a catalog row never qualifies a source or enables a financial finding.
const indiaPostPpfRevision1 = Object.freeze({
  sourceId: 'india-post-small-savings',
  revision: 1,
  publisher: 'Department of Posts, Government of India',
  officialIdentity: 'India Post small savings schemes page; PPF row and effective interval require exact parser binding.',
  endpoint: 'https://www.indiapost.gov.in/banking-services/savings',
  sourceClass: 'QUARTERLY_OFFICIAL_RATE',
  productIds: ['government:india-post:ppf'],
  claimTypes: ['CURRENT_NOMINAL_RATE'],
  expectedMimeTypes: ['text/html', 'application/javascript', 'text/javascript'],
  parserVersion: 'india-post-small-savings/qualified-identities-2',
  ruleVersion: GENIEPROOF_PPF_RATE_RULE_VERSION,
  lineage: [],
  qualificationStatus: 'BLOCKED_REUSE_RIGHTS',
  reusePermissionStatus: 'BLOCKED',
  reviewRecord: { reviewedAt: null, reference: null, scope: null },
  supersedes: null,
  revocationReasonCode: null,
});

const indiaPostPpfCandidate = Object.freeze({
  ...indiaPostPpfRevision1,
  revision: 2,
  parserVersion: GENIEPROOF_PPF_PARSER_VERSION,
  lineage: ['india-post-small-savings:1'],
  supersedes: { sourceId: 'india-post-small-savings', revision: 1 },
});

export const GENIEPROOF_SOURCE_CATALOG_CANDIDATES = Object.freeze([
  Object.freeze({
    ...indiaPostPpfRevision1,
    definitionHash: canonicalSha256(indiaPostPpfRevision1),
  }),
  Object.freeze({
    ...indiaPostPpfCandidate,
    definitionHash: canonicalSha256(indiaPostPpfCandidate),
  }),
]);
