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
