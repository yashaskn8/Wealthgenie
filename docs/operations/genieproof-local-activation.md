# GenieProof local activation and troubleshooting

**Scope:** local research only. This is not a production financial verification service. No flags, Ed25519 keys, or API tokens can qualify otherwise unapproved financial evidence. The authenticated `GET /api/genieproof/capabilities` endpoint is the source of truth for the React screen; the frontend `VITE_GENIEPROOF_ENABLED` flag is not used as authorization.

## Local PowerShell startup

Generate an Ed25519 key pair once and protect its private key outside the repository. If the previous local key-generation instructions were followed, the files already exist at `$HOME\.wealthgenie\genieproof\private.pem` and `public.pem`. **Do not regenerate keys to fix an unrelated error**; changing the signing identity can prevent existing passports from verifying unless earlier public keys are retained as trusted keys.

Start the Node backend in **the same PowerShell process** that receives these variables:

```powershell
$dir = Join-Path $HOME ".wealthgenie\genieproof"
if (!(Test-Path (Join-Path $dir "private.pem")) -or !(Test-Path (Join-Path $dir "public.pem"))) {
  throw "Local GenieProof Ed25519 key files not found."
}
$env:NODE_ENV = "development"
$env:GENIEPROOF_ENABLED = "true"
$env:GENIEPROOF_SIGNING_PRIVATE_KEY = Get-Content (Join-Path $dir "private.pem") -Raw
$env:GENIEPROOF_SIGNING_PUBLIC_KEY = Get-Content (Join-Path $dir "public.pem") -Raw
$env:GENIEPROOF_SIGNING_KEY_ID = "genieproof-local-v1"
$env:GENIEPROOF_PROOFBREAK_WORKER_ENABLED = "false"
# From the checkout's server/ directory, after separately configuring MongoDB:
npm run dev
```

Do not print the private key, commit a PEM file, place these credentials in `VITE_*` variables, or set `NODE_ENV=development` on a production server. An authenticated, transaction-capable MongoDB database is required for interactive case persistence. The optional ProofBreak worker is a separate local research component and is not necessary to review/create cases.

Sign in to the locally running app and check GenieProof again. Its status comes from the authenticated backend, not from build-time frontend flags. If the browser and backend are on different machines, the signing keys must be configured on the actual backend process; a PowerShell variable in your own laptop cannot enable a remote production backend.

## Capability reason codes

| Code | Meaning | Action |
| --- | --- | --- |
| `GENIEPROOF_LOCAL_RESEARCH_ONLY` | Server is outside development/test | Do not bypass the production gate. Use a separate local research environment. |
| `GENIEPROOF_FLAG_DISABLED` | Explicit backend flag is not `true` | Set `GENIEPROOF_ENABLED=true` in the *local* backend's startup environment. |
| `GENIEPROOF_SIGNING_KEYS_MISSING` | At least one required signing field is absent | Supply the matching private/public Ed25519 PEM and key ID. |
| `GENIEPROOF_SIGNING_CONFIGURATION_INVALID` | Malformed/mismatched keys, malformed trust JSON, invalid key ID or revoked signing key | Inspect the local private-key provisioning process; never submit credentials to the browser. |
| `FEATURE_UNAVAILABLE` | Backend was not initialized or no recognized cause was reported | Check authenticated backend availability and deployment environment. |
| `RESEARCH_ONLY_SOURCE_RIGHTS_NOT_QUALIFIED` | Local research runtime is enabled | Signing can operate in research mode, **not** independently verify current financial claims. |

Even when interactive research mode is enabled, real claim evidence may be absent because its source-specific permission and technical qualification have not been verified. In that situation the correct outcome is an unsupported/abstaining finding, not a fabricated approval. The production-safe unsaved claim extraction preview remains available without signing keys.
