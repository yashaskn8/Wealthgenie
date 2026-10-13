/**
 * Safe, compatibility-preserving reference index for the retired legacy WTI catalog.
 * Product placements, static rates, risk claims, guarantees, insurance references,
 * tax statements, and account instructions were not source-qualified and have been
 * removed. Only neutral instrument labels remain; account instructions are null.
 */
import { investmentDatabase } from './investmentDatabase.js';

const WHERE_TO_INVEST_REFERENCE_METADATA = Object.freeze(Object.fromEntries(
  investmentDatabase.map(instrument => [instrument.id, Object.freeze({
    title: `Where to invest in ${instrument.name}`,
    howToStart: null,
  })]),
));

export default WHERE_TO_INVEST_REFERENCE_METADATA;
