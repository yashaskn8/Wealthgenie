import { createHash, createPublicKey, verify } from 'node:crypto';
import { isIP } from 'node:net';

const SCOPE_KEYS = Object.freeze([
  'access', 'extraction', 'storage', 'derivation',
  'publicDisplay', 'commercialUse', 'redistribution',
]);
const exactKeys = (object, keys) => object && typeof object === 'object'
  && !Array.isArray(object) && Object.keys(object).length === keys.length
  && Object.keys(object).every(k => keys.includes(k));
const invalid = () => { const error = new Error('PROVIDER_ENTITLEMENT_UNVERIFIED'); error.code = error.message; return error; };
const decode = value => {
  if (typeof value !== 'string' || value.length < 4 || value.length > 12000
    || !/^[A-Za-z0-9_-]+$/.test(value)) throw invalid();
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) throw invalid();
  return bytes;
};
const validEndpoint = value => {
  try {
    const url = new URL(value);
    return typeof value === 'string' && value.length <= 2048
      && url.protocol === 'https:' && url.hostname.includes('.') && !isIP(url.hostname)
      && !url.username && !url.password && !url.hash
      && ![...url.searchParams.keys()].some(k => /token|secret|key|credential|password/i.test(k));
  } catch { return false; }
};

/**
 * Authenticates a provider-issued receipt against a PINNED public key delivered
 * independently of the receipt. Never reads, hashes, or stores agreements.
 * A locally invented key + receipt is not an authoritative provider grant.
 * Only the verified claims and a digest of this signed receipt may be persisted.
 */
export function verifyProviderEntitlement(receipt, trustAnchors, { now = new Date() } = {}) {
  if (!exactKeys(receipt, ['kid', 'payload', 'signature'])
    || typeof receipt.kid !== 'string' || !/^[A-Za-z0-9_.:-]{1,120}$/.test(receipt.kid)
    || !Array.isArray(trustAnchors) || !Number.isFinite(+now)) throw invalid();
  const anchor = trustAnchors.find(x => x && x.kid === receipt.kid);
  if (!anchor || trustAnchors.filter(x => x?.kid === receipt.kid).length !== 1
    || typeof anchor.issuer !== 'string'
    || !Array.isArray(anchor.endpointUrls) || anchor.endpointUrls.length < 1
    || !anchor.endpointUrls.every(validEndpoint)
    || typeof anchor.publicKeyPem !== 'string') throw invalid();
  let key, claims;
  try {
    key = createPublicKey(anchor.publicKeyPem);
    if (key.asymmetricKeyType !== 'ed25519') throw invalid();
    const bytes = decode(receipt.payload);
    claims = JSON.parse(bytes.toString('utf8'));
    const signature = decode(receipt.signature);
    if (signature.length !== 64
      || !verify(null, Buffer.from('wealthgenie-provider-entitlement-v1.' + receipt.payload),
        key, signature)) throw invalid();
  } catch { throw invalid(); }
  const keys = ['version', 'action', 'issuer', 'sourceId', 'endpointUrl', 'grantId',
    'revision', 'issuedAt', 'notBefore', 'expiresAt', 'retentionSeconds', 'permissions'];
  if (!exactKeys(claims, keys) || claims.version !== 1
    || !['GRANT', 'REVOKE'].includes(claims.action)
    || claims.issuer !== anchor.issuer
    || typeof claims.sourceId !== 'string' || !/^[A-Za-z0-9:_-]{1,160}$/.test(claims.sourceId)
    || !anchor.endpointUrls.includes(claims.endpointUrl)
    || typeof claims.grantId !== 'string' || !/^[A-Za-z0-9_.:-]{8,160}$/.test(claims.grantId)
    || !Number.isSafeInteger(claims.revision) || claims.revision < 1
    || !exactKeys(claims.permissions, SCOPE_KEYS)
    || SCOPE_KEYS.some(k => typeof claims.permissions[k] !== 'boolean')
    || !Number.isSafeInteger(claims.retentionSeconds)
    || claims.retentionSeconds < 0 || claims.retentionSeconds > 315360000) throw invalid();
  const times = [claims.issuedAt, claims.notBefore, claims.expiresAt];
  if (times.some(x => typeof x !== 'string'
    || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(x)
    || !Number.isFinite(Date.parse(x)))) throw invalid();
  const [issued, notBefore, expiry] = times.map(Date.parse);
  if (issued > +now || notBefore > +now || issued > notBefore
    || expiry <= +now || expiry <= notBefore
    || expiry - issued > 366 * 24 * 60 * 60 * 1000) throw invalid();
  if (claims.action === 'GRANT' && (
    claims.retentionSeconds === 0
    || claims.permissions.storage !== true
    || claims.permissions.access !== true
    || claims.permissions.extraction !== true
    || claims.retentionSeconds * 1000 > expiry - +now)) {
    // A grant can be narrow, but cannot authorize storing observations
    // beyond the provider's remaining authorization period.
    throw invalid();
  }
  if (claims.action === 'REVOKE'
    && (claims.retentionSeconds !== 0 || SCOPE_KEYS.some(k => claims.permissions[k]))) throw invalid();
  const digest = createHash('sha256').update(
    'wealthgenie-provider-entitlement-v1.' + receipt.payload + '.' + receipt.signature
  ).digest('hex');
  return Object.freeze({
    ...claims, kid:receipt.kid, receiptSha256:digest,
    verifiedAt:now.toISOString(), permissionState:claims.action === 'GRANT' ? 'VERIFIED' : 'REVOKED',
  });
}
