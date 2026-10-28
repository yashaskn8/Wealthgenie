# Private provider-rights registration

The financial database can hold an approval document's SHA-256 digest, an opaque
reference, reviewed scopes and dates. It does **not** need the document, its
contents, its local path or a link to it. A human authorized to read the actual
agreement must check that each requested scope and endpoint is covered before
running this offline operator command. A public website is not permission.

Create a JSON manifest **outside the repository** for one exact provider
endpoint. Keep the approval document outside the repository as well:

```json
{
  "sourceId": "approved-provider-debt",
  "endpointUrl": "https://provider.example/approved/debt-feed",
  "approvalReference": "INTERNAL-APPROVAL-REFERENCE",
  "approvalDocumentPath": "C:\\private\\provider-approval.pdf",
  "attestedBy": "Authorized reviewer",
  "reviewedAt": "2026-10-28T12:00:00Z",
  "expiresAt": null,
  "retentionSeconds": 2592000,
  "permissions": {
    "access": true,
    "extraction": true,
    "storage": true,
    "derivation": true,
    "publicDisplay": true,
    "commercialUse": true,
    "redistribution": true
  }
}
```

Every value above is an **example**, not a verified grant or a usable data feed.
Use `false` for any scope the agreement does not authorize. `retentionSeconds`
is the application's own finite retention choice and must not exceed the
provider's limit. `expiresAt` can be `null` only when the agreement has no
expiry. The reviewer must not place confidential text in `approvalReference`.

From the repository root, after `npm run finance:pg:migrate --prefix server`
has applied the private-evidence migration:

```powershell
$env:DOTENV_CONFIG_PATH = 'C:\path\to\server\.env'
$env:FINANCE_RIGHTS_OPERATOR_CONFIRMED = 'yes'
npm run finance:rights:register --prefix server -- 'C:\private\rights-manifest.json' --apply
```

The command hashes the local document in a bounded stream and stores only its
digest and reviewed metadata in the audited `finance.provider_rights` row. It
refuses an existing source ID, so changes and revocations need an explicit
review. Registration alone does not create a product, qualify its tax class,
ingest a current observation, establish suitability, or enable personalized
advice. The AA bond family still needs two independently evidenced ISINs and
their current terms, rating/risk, tax treatment and publishable observations.

The Top 3 evidence review queue uses `providerApprovalReference` to link a
candidate product to this non-confidential rights metadata. It never asks for
an approval-document URL; the document and its path remain outside the queue,
PostgreSQL, and GitHub.
