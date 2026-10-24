/** Small initial allowlist; no pattern matching on user-provided host substrings. */
export const PUBLIC_RESEARCH_HOSTS=Object.freeze([
  'rbi.org.in','www.rbi.org.in',
  'sebi.gov.in','www.sebi.gov.in',
  'indiapost.gov.in','www.indiapost.gov.in'
]);
const RESTRICTED_PATH_SEGMENT=/(?:^|\/)(?:login|signin|sign-in|auth|account|accounts|myaccount|profile|dashboard|payment|payments|kyc|transaction|transactions|portfolio|admin)(?:\/|$)/i;
export function isApprovedPublicResearchUrl(raw) {
  if(typeof raw!=='string'||raw.length>2048)return false;
  try {
    const u=new URL(raw);
    return u.protocol==='https:' && !u.username && !u.password &&
      (u.port===''||u.port==='443') &&
      PUBLIC_RESEARCH_HOSTS.includes(u.hostname.toLowerCase()) &&
      // Reject query/fragment URLs and encoded paths until a source-specific
      // reviewed routing policy exists (double-decoding and private-page risk).
      u.search==='' && u.hash==='' && !u.pathname.includes('%') &&
      !RESTRICTED_PATH_SEGMENT.test(u.pathname);
  } catch {return false;}
}
