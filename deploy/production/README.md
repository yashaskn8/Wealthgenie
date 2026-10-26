# Production overlay

The base manifests are retained for ephemeral Kind validation. This overlay is
the production topology contract: HTTPS redirect is enabled, the browser origin
is HTTPS-only, and the server is configured for TLS-protected DocumentDB.

The production overlay deliberately rewrites all three application images and
the Redis image present in the rendered topology to
`registry-required.invalid/...@sha256:WEALTHGENIE_*_IMAGE_DIGEST_REQUIRED`
sentinels. These are not deployable image identities. Do not apply the overlay
directly. A release workspace must replace each sentinel with its approved
repository path and verified `sha256:<64 lowercase hex>` digest. The validator
currently binds WealthGenie application images to `ghcr.io/yashaskn8/wealthgenie-*`
and Redis to `docker.io/library/redis`. MongoDB is not part of the production
Kustomize overlay; production uses the separately provisioned external
DocumentDB endpoint described below. Other registry owners or mirrors fail
closed and require an explicit release-policy and test update.
Before apply, pipe the rendered overlay through the fail-closed image filter:

```sh
set -o pipefail
kubectl kustomize deploy/production \
  | node server/scripts/validateProductionImageManifest.js \
  | kubectl apply -f -
```

The filter emits no manifest bytes unless every image in the rendered
production topology is a fully qualified registry digest; mutable tags, local
Docker image IDs, placeholders, and missing application or infrastructure
images fail validation. Standalone production migration Job manifests must
pass the same filter with `--fragment` before they are applied. The migration
images remain excluded from ordinary Kustomize resources and must be pinned to
the same approved release.

This repository does not publish application images to a production registry
or attest registry digests. The local Docker image IDs recorded by the Kind
workflow are not registry digests and must not be reused as production proof.
Until an operator-controlled release pipeline binds the digests to the exact
source/build provenance, registry-to-runtime evidence remains pending.

Before applying, replace all `${WEALTHGENIE_PRODUCTION_HOST}`,
`${WEALTHGENIE_PRODUCTION_TLS_SECRET}`, and
`${WEALTHGENIE_DOCUMENTDB_CA_SECRET}` placeholders with real deployment values.
The referenced TLS and DocumentDB CA secrets must already exist. Applying this
overlay with placeholders is intentionally unsupported and must be rejected by
the deployment pipeline.

The production API and dedicated agent worker read the same required
`wealthgenie-secrets/REDIS_URL`. This overrides the Kind ConfigMap URL; the
Secret must be provisioned before deploying either service. Put the exact
approved managed `rediss://host:port` endpoint (optionally with a Redis ACL
username) and its matching random 32+ character `REDIS_PASSWORD` into
`wealthgenie-secrets` through a cluster secret manager. The explicit password
takes precedence over any password embedded in the URL. Never store credentials
in this repository, a public issue or the browser.

The production environment validator rejects external `redis://` plaintext
connections, malformed URLs and missing authentication. The API/worker startup
already requires Redis, while readiness and sensitive Redis-backed operations
fail closed on outages. Merely setting the environment variables does not
prove provider reachability. Verify authenticated PING, token revocation, the
read-only Plan Review API-to-worker lifecycle and reconnect behavior when the
external Redis service has been provisioned. The Kind test environment still
uses its isolated authenticated in-cluster Redis.

The production secret provider must supply a strong, randomly generated
`REDIS_PASSWORD`. Redis requires authentication, and the checked-in
NetworkPolicy limits Redis ingress to the WealthGenie server and agent-worker
pods. The production cluster CNI must enforce Kubernetes NetworkPolicy; Redis
authentication remains required even when that network control is unavailable.
The Redis service uses in-cluster TCP, so deploy it only on a trusted cluster
network with node and pod traffic protected by the cluster boundary.

The Terraform in this repository provisions network, database, ALB, and DNS
scaffolding only. Application compute/runtime attachment remains a separate
deployment step.

The Kind CD workflow applies database prerequisites, runs and waits for the
Phase-2 index migration, then the Phase-3 shared-state migration, then the
trusted serving-bundle bootstrap, and only then applies application workloads.
The bootstrap verifies the checked-in external bundle anchors and registers the
complete bundles in shared GridFS; it never replaces an already active model.
These jobs use the base MongoDB topology and ephemeral
`wealthgenie-secrets/MONGODB_URI` used by Kind.

Production DocumentDB/runtime attachment is separate: its deployment pipeline
must provide controlled one-shot Phase-2 and Phase-3 migrations and the trusted
bundle bootstrap with the production URI and TLS/CA configuration before API/ML
rollout. Do not apply Kind-specific jobs unchanged to DocumentDB. The production
database must support the transactions required by model activation and RAG
lifecycle writes. Application startup verifies migration state read-only and
never creates indexes or guesses model state.

## Optional financial workspace release contract

Cash Check and Household Runway are **disabled by default in a production
frontend image**. Vite compiles their flags into browser assets, so changing a
Kubernetes ConfigMap **cannot** turn on a workspace in an already built image.
The Dockerfile accepts explicit
`--build-arg VITE_COVERAGE_ENABLED=true` and
`--build-arg VITE_RUNWAY_ENABLED=true`, defaulting both to `false`.

Before building a production image with either flag enabled:

1. Verify the corresponding authenticated API, migration/index prerequisites,
   data isolation, restore/erasure, risk and audit gates on the exact release SHA.
2. For Cash Check, opt in the server separately with `COVERAGE_ENABLED=true`.
   For Runway, opt in with `RUNWAY_ENABLED=true`, and provision the server-side
   `RUNWAY_INTEGRITY_SECRET`, `RUNWAY_EVIDENCE_KEY_V1` and key identifier
   according to the hardened runtime configuration. Do not copy secrets into
   Docker build args or client-side Vite variables.
3. Build and publish the frontend with only the corresponding approved Vite
   flag(s). Attach the immutable digest and the approved build provenance to the
   production release; never substitute a local Kind image ID for this digest.
4. Test login, feature entry, current-state reads, ownership, stale revisions,
   save/export/erasure and logout against the real production-like environment.
   Check the matching backend feature flag and the final frontend image before
   admitting live user traffic.

If the backend is disabled, the UI must not advertise the feature as available.
A disabled frontend flag does not secure a backend API: authenticated clients
can still call enabled routes, so keep the backend feature off until both its
safety gates and the frontend rollout are approved. GenieVoice task execution and its optional durable
receipt store remain independently opt-in via `GENIEVOICE_TASKS_ENABLED` and
`GENIEVOICE_RECEIPTS_ENABLED`; a visible voice conversation UI does not mean
tasks or receipts are ready.

The CI/CD workflow verifies a disposable **Kind** cluster, not an external
production release. Real production rollout still requires an operator-approved
registry publishing/attestation pipeline, release-scoped migrations, TLS,
database and Redis credentials, monitoring, rollback and backup/restore drills.
Never treat a successful Kind run as proof that these operator-only steps ran.

## Account persistence and database identity

The API reads registrations and logins from the active MongoDB database, **not**
Redis. Different MongoDB URI database names (for example `wealthgenie` and
`wealthgenie-demo`) contain different accounts, so a correct password can
otherwise appear invalid after switching server configurations.

Pin `MONGODB_EXPECTED_DATABASE` in the server runtime environment to the actual,
existing persistent database name from the approved MongoDB URI, after verifying
that database with your cluster operator. The backend checks the connected
database name at startup and refuses mismatches instead of silently exposing
an empty user collection. This is an opt-in protection; deploying the code
alone does not change or migrate any existing account.

For incident diagnosis, inspect **server-side** login log entries `Login rejected`.
`ACCOUNT_NOT_FOUND` suggests the account is absent from the connected database
or the entered email differs; `PASSWORD_MISMATCH` indicates an account was found
but the provided password did not verify. The external response remains a
generic 401 in both cases. Do not log or share user passwords, account emails,
JWT tokens, database URIs, or MongoDB credentials. Check persistent storage,
replica-set configuration and recent configuration changes before creating
replacement accounts. Backup/restore must follow the operator's change controls.
