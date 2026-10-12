/**
 * The retained India Post bundle fixtures contain an independent heading and
 * JSON rate array. Neither proximity nor one occurrence of each establishes
 * that the heading's quarter applies to that array. No captured, qualified
 * provider record in this repository establishes that structural relationship.
 *
 * Until that source-specific record contract is independently qualified, this
 * adapter must refuse all source-to-fact extraction. In particular, do not
 * invent a new JSON wrapper or a rendering pattern and call it provider data.
 * The shared market-data parser is deliberately outside this GenieProof gate.
 */
export function parseGenieProofIndiaPostPpfBundle(bundleText) {
  const reasonCode = typeof bundleText === 'string' && bundleText.trim()
    ? 'SOURCE_RECORD_ASSOCIATION_UNQUALIFIED'
    : 'SOURCE_BYTES_UNAVAILABLE';
  throw Object.assign(new Error('The India Post source-to-fact record association has not been qualified.'), {
    status: 503,
    code: 'GENIEPROOF_SOURCE_SCHEMA_REJECTED',
    reasonCode,
  });
}
