# Provider verification without confidential documents

## Scope and trust boundary

WealthGenie does not need your confidential mobile-held permission documents, screenshots,
file paths, passwords, or document hashes. Never upload them to the repository, chat,
CI artifacts, laptop, PostgreSQL, or a server. The old private-document hashing
operator workflow remains available as legacy tooling but its registrations are
**PENDING** under migration 012; a hash or owner attestation does NOT activate rights.

This capability is a **generic verification interface**, not a claim that NSE,
Upstox, AMFI, or any particular data provider currently issues this receipt
format or has granted WealthGenie commercial permissions. Provider-granted
rights must be independently established, or the source stays blocked.

## Provider-issued, independently authenticated receipt

The offline verifier accepts a JSON object with `kid`, `payload`, and
`signature`. The payload is a base64url-encoded provider-issued JSON claim.
Its Ed25519 signature covers the domain-separated payload bytes.
It must specify the exact provider issuer, provider endpoint, source ID,
stable grant ID, monotonically increasing revision, action (GRANT or REVOKE),
issue/effective/expiry times, retention limit, and **seven separate scope flags**.

The trust-anchor JSON array is maintained outside the repository and independently
obtained from the provider's authenticated channel. Each entry contains
`kid`, `issuer`, `endpointUrls`, and `publicKeyPem`. A public key that
arrives only inside the same receipt is **not** a trust anchor. Do not fabricate
provider keys or grants. Do not use a fake receipt to unlock production.

Once a provider offers that verifiable, non-confidential entitlement, an
authorized operator can register it after migration and independent key verification:

```powershell
$env:FINANCE_PROVIDER_TRUST_ANCHORS_PATH = 'C:\secure\provider-public-keys.json'
$env:FINANCE_RIGHTS_OPERATOR_CONFIRMED = 'yes'
# Configure FINANCIAL_POSTGRES_URL securely; never commit credentials.
npm run finance:pg:migrate --prefix server
npm run finance:rights:signed --prefix server -- 'C:\secure\signed-entitlement.json' --apply
```

Those files are **non-confidential provider metadata**, never the approval
document or any content derived from it. They must remain outside the repo
and be provisioned securely. The signed receipt's SHA-256 digest is recorded,
not any permission document fingerprint. Existing rows cannot be promoted by
the legacy registration script.

## State and release behavior

- `PENDING`: no verified provider grant; no publishable observation.
- `VERIFIED`: independent signature, exact source/endpoint, permissions and
  expiry validated. Publication still requires all actual operation rights,
  current observations, independently qualified products and relevant advice authorization.
- `EXPIRED`: effective state when the trusted grant's expiry is reached,
  even before database maintenance updates its stored state. Reads fail closed.
- `REVOKED`: a newer signed provider revocation permanently blocks that source;
  emergency operator revocation also blocks reads immediately. A new source
  registration/independent review is required to restart.
- `REJECTED`: explicitly rejected permission; cannot directly become VERIFIED.

PostgreSQL migration 012 adds the verification gate and immutable receipt ledger.
Additive migration 013 permits emergency narrowing or revocation while blocking
unsigned permission escalation and stale grant replay. Read, qualification,
and 250-family audit queries recheck source verification and expiry.

No code change independently verifies the **250 investment families**.
Each family still requires two real, distinct, licensed, current, eligible
products with verified issuer identity, tax class, source facts and risk/terms.
When proof is missing, return zero rather than fabricate a candidate.

## Before considering production

1. Get real independent provider authentication of exact permitted use,
   without supplying the confidential agreement. If no verifiable proof
   channel exists, use a differently authorized source instead.
2. Run the financial PostgreSQL migration and red-team tests in an isolated
   database. Do not migrate a live database without normal change controls,
   backup, and rollback planning.
3. Use a DB role with least privilege. Only an offline operator may write
   `finance.provider_rights` or the immutable receipt ledger; ordinary web
   requests must not have table write grants.
4. Confirm live source expiry and signed/provider revocation, cache
   invalidation, current market-data rights, investor suitability, all required
   same-commit CI gates, and a real staging deployment. A green synthetic
   fixture does **not** establish a valid provider licence.
