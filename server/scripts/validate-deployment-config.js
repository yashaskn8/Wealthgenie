import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const root = path.resolve(process.env.WEALTHGENIE_VALIDATION_ROOT || defaultRoot);
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const compose = parse(read('docker-compose.yml'));
if (!compose.services?.server || !compose.services?.['agent-worker']) throw new Error('Compose must define server and agent-worker services');
if (compose.services.server.environment?.includes?.('AGENT_WORKER_ENABLED=false') !== true) throw new Error('Compose API must disable embedded workers');
if (compose.services['agent-worker'].command?.join(' ') !== 'node worker.js') throw new Error('Compose agent-worker must run node worker.js');

const deploymentFiles = [];
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml')) deploymentFiles.push(full);
  }
}
walk(path.join(root, 'k8s'));
const docs = deploymentFiles.map(file => ({ file, value: parse(fs.readFileSync(file, 'utf8')) }));
const worker = docs.find(item => item.value?.kind === 'Deployment' && item.value?.metadata?.name === 'wealthgenie-agent-worker');
if (!worker) throw new Error('Kubernetes agent-worker Deployment is missing');
const workerPodSpec = worker.value.spec.template.spec;
const container = workerPodSpec.containers.find(item => item.name === 'agent-worker');
if (!container || container.command?.join(' ') !== 'node worker.js') throw new Error('Kubernetes agent-worker command is invalid');
if (workerPodSpec.securityContext?.runAsNonRoot !== true || workerPodSpec.securityContext?.runAsUser !== 1000) {
  throw new Error('Kubernetes agent-worker must explicitly run as non-root UID 1000');
}
if (!container.readinessProbe?.httpGet?.path || !container.livenessProbe?.httpGet?.path) throw new Error('Kubernetes agent-worker probes are required');

const redisDeployment = docs.find(item => item.value?.kind === 'Deployment'
  && item.value?.metadata?.name === 'wealthgenie-redis');
const redisContainer = redisDeployment?.value.spec.template.spec.containers
  .find(item => item.name === 'redis');
const redisEnv = new Map((redisContainer?.env || []).map(item => [item.name, item]));
if (!redisContainer?.args?.includes('--requirepass')
    || !redisContainer.args.includes('$(REDIS_PASSWORD)')
    || redisEnv.get('REDIS_PASSWORD')?.valueFrom?.secretKeyRef?.name !== 'wealthgenie-secrets'
    || redisEnv.get('REDIS_PASSWORD')?.valueFrom?.secretKeyRef?.key !== 'REDIS_PASSWORD'
    || redisEnv.get('REDISCLI_AUTH')?.valueFrom?.secretKeyRef?.name !== 'wealthgenie-secrets'
    || redisEnv.get('REDISCLI_AUTH')?.valueFrom?.secretKeyRef?.key !== 'REDIS_PASSWORD') {
  throw new Error('Kubernetes Redis must require the shared secret password and authenticate its probes');
}
for (const deploymentName of ['wealthgenie-server', 'wealthgenie-agent-worker']) {
  const deployment = docs.find(item => item.value?.kind === 'Deployment'
    && item.value?.metadata?.name === deploymentName);
  const appContainer = deployment?.value.spec.template.spec.containers[0];
  if (!appContainer?.env?.some(item => item.name === 'REDIS_PASSWORD'
      && item.valueFrom?.secretKeyRef?.name === 'wealthgenie-secrets'
      && item.valueFrom?.secretKeyRef?.key === 'REDIS_PASSWORD')) {
    throw new Error(`Kubernetes ${deploymentName} must receive the Redis password from the secret store`);
  }
}
const redisNetworkPolicy = docs.find(item => item.value?.kind === 'NetworkPolicy'
  && item.value?.metadata?.name === 'wealthgenie-redis-ingress')?.value;
const redisIngressRules = redisNetworkPolicy?.spec?.ingress || [];
const redisPeers = redisIngressRules.flatMap(rule => rule.from || []);
const redisPeerApps = new Set(redisPeers.map(peer => peer.podSelector?.matchLabels?.app));
if (redisNetworkPolicy?.spec?.podSelector?.matchLabels?.app !== 'wealthgenie-redis'
    || redisNetworkPolicy.spec.policyTypes?.includes('Ingress') !== true
    || redisIngressRules.length !== 1
    || redisIngressRules.some(rule => !Array.isArray(rule.from) || rule.from.length === 0)
    || redisPeers.length !== 2
    || redisPeerApps.size !== 2
    || !redisPeerApps.has('wealthgenie-server')
    || !redisPeerApps.has('wealthgenie-agent-worker')
    || redisPeers.some(peer => !peer.podSelector || peer.namespaceSelector || peer.ipBlock)
    || redisNetworkPolicy.spec.ingress.some(rule => rule.ports?.length !== 1
      || rule.ports[0].protocol !== 'TCP' || rule.ports[0].port !== 6379)) {
  throw new Error('Kubernetes Redis ingress must be limited to server and agent-worker pods on TCP 6379');
}

const migration = docs.find(item => item.value?.kind === 'Job'
  && item.value?.metadata?.labels?.app === 'wealthgenie-phase2-index-migration');
if (!migration) throw new Error('The one-shot Phase 2 index migration Job is missing');
const migrationSpec = migration.value.spec;
const migrationContainer = migrationSpec.template.spec.containers.find(item => item.name === 'phase2-index-migration');
if (migrationSpec.parallelism !== 1 || migrationSpec.completions !== 1 || migrationSpec.backoffLimit !== 0) {
  throw new Error('Phase 2 index migration must be a single, non-parallel, fail-closed Job');
}
if (migrationSpec.template.spec.restartPolicy !== 'Never'
    || migrationContainer?.image !== 'wealthgenie-server:latest'
    || migrationContainer?.command?.join(' ') !== 'node scripts/migratePhase2Indexes.js'
    || !migrationContainer.env?.some(item => item.name === 'MONGODB_MIGRATION_URI'
      && item.valueFrom?.secretKeyRef?.name === 'wealthgenie-secrets'
      && item.valueFrom?.secretKeyRef?.key === 'MONGODB_URI')) {
  throw new Error('Phase 2 migration Job must run the explicit script with the configured database URI');
}

const phase4MigrationJobs = docs.filter(item => item.value?.kind === 'Job'
  && item.value?.metadata?.labels?.app === 'wealthgenie-phase4-plan-review-migration');
if (phase4MigrationJobs.length !== 1) throw new Error('Exactly one Phase 4 PlanReview migration Job must be defined');
const phase4Spec = phase4MigrationJobs[0].value.spec;
const phase4Container = phase4Spec.template.spec.containers.find(item => item.name === 'phase4-plan-review-migration');
if (phase4Spec.parallelism !== 1 || phase4Spec.completions !== 1 || phase4Spec.backoffLimit !== 0) {
  throw new Error('Phase 4 PlanReview migration must be a single, non-parallel, fail-closed Job');
}
if (phase4Spec.template.spec.restartPolicy !== 'Never'
    || phase4Container?.image !== 'wealthgenie-server:latest'
    || phase4Container?.command?.join(' ') !== 'node scripts/migratePlanReviewIndexes.js'
    || !phase4Container.env?.some(item => item.name === 'MONGODB_MIGRATION_URI'
      && item.valueFrom?.secretKeyRef?.name === 'wealthgenie-secrets'
      && item.valueFrom?.secretKeyRef?.key === 'MONGODB_URI')) {
  throw new Error('Phase 4 migration Job must run its explicit script with the configured database URI');
}

const phase5MigrationJobs = docs.filter(item => item.value?.kind === 'Job'
  && item.value?.metadata?.labels?.app === 'wealthgenie-phase5-agent-runtime-migration');
if (phase5MigrationJobs.length !== 1) throw new Error('Exactly one Phase 5 durable agent runtime migration Job must be defined');
const phase5Spec = phase5MigrationJobs[0].value.spec;
const phase5Container = phase5Spec.template.spec.containers.find(item => item.name === 'phase5-agent-runtime-migration');
if (phase5Spec.parallelism !== 1 || phase5Spec.completions !== 1 || phase5Spec.backoffLimit !== 0) {
  throw new Error('Phase 5 durable agent runtime migration must be a single, non-parallel, fail-closed Job');
}
if (phase5Spec.template.spec.restartPolicy !== 'Never'
    || phase5Container?.image !== 'wealthgenie-server:latest'
    || phase5Container?.command?.join(' ') !== 'node scripts/migratePhase5AgentRuntimeIndexes.js'
    || !phase5Container.env?.some(item => item.name === 'MONGODB_MIGRATION_URI'
      && item.valueFrom?.secretKeyRef?.name === 'wealthgenie-secrets'
      && item.valueFrom?.secretKeyRef?.key === 'MONGODB_URI')) {
  throw new Error('Phase 5 migration Job must run the explicit migration with the configured database URI');
}

const phase7MigrationJobs = docs.filter(item => item.value?.kind === 'Job'
  && item.value?.metadata?.labels?.app === 'wealthgenie-phase7-research-task-migration');
if (phase7MigrationJobs.length !== 1) throw new Error('Exactly one Phase 7 ResearchAgent task migration Job must be defined');
const phase7Spec = phase7MigrationJobs[0].value.spec;
const phase7Container = phase7Spec.template.spec.containers.find(item => item.name === 'phase7-research-task-migration');
if (phase7Spec.parallelism !== 1 || phase7Spec.completions !== 1 || phase7Spec.backoffLimit !== 0) {
  throw new Error('Phase 7 ResearchAgent task migration must be a single, non-parallel, fail-closed Job');
}
if (phase7Spec.template.spec.restartPolicy !== 'Never'
    || phase7Container?.image !== 'wealthgenie-server:latest'
    || phase7Container?.command?.join(' ') !== 'node scripts/migrateResearchTaskIndexes.js'
    || !phase7Container.env?.some(item => item.name === 'MONGODB_MIGRATION_URI'
      && item.valueFrom?.secretKeyRef?.name === 'wealthgenie-secrets'
      && item.valueFrom?.secretKeyRef?.key === 'MONGODB_URI')) {
  throw new Error('Phase 7 task migration Job must run its explicit migration with the configured database URI');
}

const phase3MigrationJobs = docs.filter(item => item.value?.kind === 'Job'
  && item.value?.metadata?.labels?.app === 'wealthgenie-phase3-state-migration');
if (phase3MigrationJobs.length !== 1) throw new Error('Exactly one Phase 3 ML/RAG state migration Job must be defined');
const phase3Spec = phase3MigrationJobs[0].value.spec;
const phase3Container = phase3Spec.template.spec.containers.find(item => item.name === 'phase3-state-migration');
if (phase3Spec.parallelism !== 1 || phase3Spec.completions !== 1 || phase3Spec.backoffLimit !== 0) {
  throw new Error('Phase 3 migration must be a single, non-parallel, fail-closed Job');
}
if (phase3Spec.template.spec.restartPolicy !== 'Never'
    || phase3Container?.image !== 'wealthgenie-ml-service:latest'
    || phase3Container?.command?.join(' ') !== 'python scripts/migrate_phase3_state.py'
    || !phase3Container.env?.some(item => item.name === 'MONGODB_URI'
      && item.valueFrom?.secretKeyRef?.name === 'wealthgenie-secrets'
      && item.valueFrom?.secretKeyRef?.key === 'MONGODB_URI')) {
  throw new Error('Phase 3 migration Job must run the explicit migration with the configured database URI');
}

const kustomization = parse(read('k8s/kustomization.yaml'));
if (kustomization.resources?.some(resource => resource.includes('phase2-index-migration')
    || resource.includes('phase3-state-migration')
    || resource.includes('phase4-plan-review-migration')
    || resource.includes('phase5-agent-runtime-migration')
    || resource.includes('phase7-research-task-migration'))) {
  throw new Error('One-shot database migration Jobs must only be created by ordered deployment steps');
}

// Model selection is service-specific: Kind uses a deterministic mock, and
// production API credentials are never forwarded to the frontend or ML model.
const baseConfig = parse(read('k8s/configmap.yaml'));
const productionApiPatch = parse(read('deploy/production/server-patch.yaml'));
const productionApi = productionApiPatch.spec?.template?.spec?.containers?.find(item => item.name === 'server');
const productionApiVars = new Map((productionApi?.env || []).map(entry => [entry.name, entry]));
const productionWorkerPatch = parse(read('deploy/production/worker-patch.yaml'));
const productionWorker = productionWorkerPatch.spec?.template?.spec?.containers?.find(item => item.name === 'agent-worker');
const productionWorkerVars = new Map((productionWorker?.env || []).map(item => [item.name, item]));
const requiredRedisUrlSecret = item => item?.valueFrom?.secretKeyRef?.name === 'wealthgenie-secrets'
  && item.valueFrom.secretKeyRef.key === 'REDIS_URL' && item.valueFrom.secretKeyRef.optional !== true;
if (!requiredRedisUrlSecret(productionApiVars.get('REDIS_URL'))
    || !requiredRedisUrlSecret(productionWorkerVars.get('REDIS_URL'))) {
  throw new Error('Production API and worker must use the same required Redis URL Secret');
}
const mlDeployment = docs.find(item => item.value?.kind === 'Deployment'
  && item.value?.metadata?.name === 'wealthgenie-ml-service')?.value;
const workerDeployment = docs.find(item => item.value?.kind === 'Deployment'
  && item.value?.metadata?.name === 'wealthgenie-agent-worker')?.value;
const restrictedKeys = new Set(['GROQ_API_KEY', 'GEMINI_API_KEY', 'NVIDIA_API_KEY', 'UPSTOX_ANALYTICS_TOKEN', 'UPSTOX_ACCESS_TOKEN']);
if (baseConfig.data?.LLM_DEFAULT_PROVIDER !== 'mock'
    || productionApiVars.get('LLM_DEFAULT_PROVIDER')?.value !== 'api'
    || productionApiVars.get('LLM_PRIMARY_PROVIDER')?.value !== 'GROQ'
    || mlDeployment?.spec?.template?.spec?.containers?.[0]?.env?.some(entry => restrictedKeys.has(entry.name))
    || workerDeployment?.spec?.template?.spec?.containers?.[0]?.env?.some(entry => restrictedKeys.has(entry.name))) {
  throw new Error('Kind model must remain mocked; production API must explicitly select server-side LLM; keys must not flow to ML or worker');
}

// A production-enabled read-only Plan Review must never imply an embedded
// production worker or skip the ordered persistence migrations. Keep Kind's
// fixture environment disabled, and require the production overlay to
// explicitly opt in for both the API and the external worker.
const productionConfig = parse(read('deploy/production/config-patch.yaml'));
const productionData = productionConfig.data || {};
const workerContainer = workerDeployment?.spec?.template?.spec?.containers?.find(item => item.name === 'agent-worker');
const workerEnv = new Map((workerContainer?.env || []).map(item => [item.name, item.value]));
if (baseConfig.data?.AGENTIC_PLAN_REVIEW_ENABLED !== 'false'
    || baseConfig.data?.AGENT_WORKER_ENABLED !== 'false'
    || productionData.AGENTIC_PLAN_REVIEW_ENABLED !== 'true'
    || productionData.AGENT_STREAM_ENABLED !== 'true'
    || productionData.REQUIRE_REDIS !== 'true'
    || productionData.LLM_GEMINI_FALLBACK_ENABLED !== 'true'
    || workerEnv.get('AGENT_WORKER_MODE') !== 'external'
    || workerEnv.get('AGENT_WORKER_ENABLED') !== 'true'
    || !workerContainer?.readinessProbe?.httpGet?.path
    || !workerContainer?.startupProbe?.httpGet?.path
    || !productionKustomizationContainsMigrations()) {
  throw new Error('Plan Review production activation requires an external ready worker, explicit stream feature and ordered Phase 4/5 migrations');
}

function productionKustomizationContainsMigrations() {
  // Migrations are intentionally excluded from the persistent workload and
  // verified as explicit ordered CD jobs below, not deployed as crash-looping Jobs.
  const workflow = parse(read('.github/workflows/cd.yml'));
  const source = JSON.stringify(workflow);
  return source.includes('phase4-plan-review') && source.includes('phase5-agent-runtime');
}

const productionKustomization = parse(read('deploy/production/kustomization.yaml'));
const requiredProductionImages = new Map([
  ['wealthgenie-server', 'sha256:WEALTHGENIE_SERVER_IMAGE_DIGEST_REQUIRED'],
  ['wealthgenie-frontend', 'sha256:WEALTHGENIE_FRONTEND_IMAGE_DIGEST_REQUIRED'],
  ['wealthgenie-ml-service', 'sha256:WEALTHGENIE_ML_SERVICE_IMAGE_DIGEST_REQUIRED'],
  ['redis', 'sha256:WEALTHGENIE_REDIS_IMAGE_DIGEST_REQUIRED'],
]);
const configuredProductionImages = new Map((productionKustomization.images || []).map(image => [image.name, image]));
if (requiredProductionImages.size !== configuredProductionImages.size
    || [...requiredProductionImages].some(([name, digest]) => {
      const image = configuredProductionImages.get(name);
      return image?.newName !== `registry-required.invalid/${name}`
        || image?.digest !== digest
        || Object.hasOwn(image || {}, 'newTag');
    })) {
  throw new Error('Production overlay must replace every application image with an explicit digest-required fail-closed marker');
}

function namedStep(steps, name) {
  const index = steps.findIndex(step => step.name === name);
  if (index < 0) throw new Error(`Required deployment step is missing: ${name}`);
  return { index, step: steps[index] };
}

const ci = parse(read('.github/workflows/ci.yml'));
const browserSteps = ci.jobs?.['integration-security']?.steps || [];
if (browserSteps.filter(step => step.name === 'Migrate Phase 7 ResearchAgent task persistence').length !== 1) {
  throw new Error('Browser CI must run exactly one Phase 7 ResearchAgent task migration');
}
const browserMongo = namedStep(browserSteps, 'Start transaction-capable MongoDB');
const browserInstall = namedStep(browserSteps, 'Install application and browser dependencies');
const browserPhase2Migration = namedStep(browserSteps, 'Migrate Phase 2 persistence indexes');
const browserPhase3Migration = namedStep(browserSteps, 'Migrate Phase 3 ML/RAG shared-state indexes');
const browserPhase4Migration = namedStep(browserSteps, 'Migrate Phase 4 PlanReview persistence indexes');
const browserPhase5Migration = namedStep(browserSteps, 'Migrate Phase 5 durable agent runtime persistence');
const browserPhase7Migration = namedStep(browserSteps, 'Migrate Phase 7 ResearchAgent task persistence');
const browserModelActivation = namedStep(browserSteps, 'Verify transactional ML model activation');
const browserArtifactVerification = namedStep(browserSteps, 'Verify trusted serving artifact bundles');
const browserStart = namedStep(browserSteps, 'Start real application services');
if (!(browserInstall.index < browserMongo.index
    && browserMongo.index < browserPhase2Migration.index
    && browserPhase2Migration.index < browserPhase3Migration.index
    && browserPhase3Migration.index < browserPhase4Migration.index
    && browserPhase4Migration.index < browserPhase5Migration.index
    && browserPhase5Migration.index < browserPhase7Migration.index
    && browserPhase7Migration.index < browserModelActivation.index
    && browserModelActivation.index < browserArtifactVerification.index
    && browserArtifactVerification.index < browserStart.index)
    || !browserPhase2Migration.step.run?.includes('MONGODB_MIGRATION_URI="$MONGODB_URI" npm run migrate:phase2-indexes --prefix server')
    || browserPhase3Migration.step['working-directory'] !== 'ml-service'
    || !browserPhase3Migration.step.run?.includes('python scripts/migrate_phase3_state.py')
    || !browserPhase4Migration.step.run?.includes('MONGODB_MIGRATION_URI="$MONGODB_URI" npm run migrate:phase4-plan-review-indexes --prefix server')
    || !browserPhase5Migration.step.run?.includes('MONGODB_MIGRATION_URI="$MONGODB_URI" npm run migrate:phase5-agent-runtime --prefix server')
    || !browserPhase7Migration.step.run?.includes('MONGODB_MIGRATION_URI="$MONGODB_URI" npm run migrate:phase7-research-tasks --prefix server')) {
  throw new Error('Browser CI must run all ordered database migrations and artifact checks before starting application services');
}

const edgeSteps = ci.jobs?.['integration-security']?.steps || [];
const edgeMongo = namedStep(edgeSteps, 'Start MongoDB for the explicit ML/RAG state migration');
const edgeMongoReady = namedStep(edgeSteps, 'Wait for transaction-capable MongoDB primary');
const edgePhase2 = namedStep(edgeSteps, 'Run the explicit Phase 2 persistence migration');
const edgePhase3 = namedStep(edgeSteps, 'Run the explicit Phase 3 ML/RAG state migration before starting application replicas');
const edgePhase4 = namedStep(edgeSteps, 'Run the explicit Phase 4 PlanReview persistence migration');
const edgePhase5 = namedStep(edgeSteps, 'Run the explicit Phase 5 durable agent runtime migration');
const edgePhase7 = namedStep(edgeSteps, 'Run the explicit Phase 7 ResearchAgent task migration');
const edgeRagBootstrap = namedStep(edgeSteps, 'Bootstrap the production-image shared RAG corpus');
const edgeArtifactVerification = namedStep(edgeSteps, 'Verify trusted serving artifacts in the production image');
const edgeArtifactRegistration = namedStep(edgeSteps, 'Register verified serving bundles in MongoDB');
const edgeStart = namedStep(edgeSteps, 'Start the real Nginx edge stack');
const edgeReady = namedStep(edgeSteps, 'Wait for backend and published Nginx frontend');
const edgePlaywright = namedStep(edgeSteps, 'Run production-edge Playwright test through Nginx');
if (!(edgeMongo.index < edgeMongoReady.index
    && edgeMongoReady.index < edgePhase2.index
    && edgePhase2.index < edgePhase3.index
    && edgePhase3.index < edgePhase4.index
    && edgePhase4.index < edgePhase5.index
    && edgePhase5.index < edgePhase7.index
    && edgePhase7.index < edgeRagBootstrap.index
    && edgeRagBootstrap.index < edgeArtifactVerification.index
    && edgeArtifactVerification.index < edgeArtifactRegistration.index
    && edgeArtifactRegistration.index < edgeStart.index
    && edgeStart.index < edgeReady.index
    && edgeReady.index < edgePlaywright.index)
    || !edgePhase2.step.run?.includes('MONGODB_MIGRATION_URI=')
    || !edgePhase2.step.run?.includes('server npm run migrate:phase2-indexes')
    || !edgePhase3.step.run?.includes('python scripts/migrate_phase3_state.py')
    || !edgePhase4.step.run?.includes('server npm run migrate:phase4-plan-review-indexes')
    || !edgePhase5.step.run?.includes('server npm run migrate:phase5-agent-runtime')
    || !edgePhase7.step.run?.includes('server npm run migrate:phase7-research-tasks')
    || !edgeRagBootstrap.step.run?.includes('python scripts/bootstrap_rag_corpus.py')
    || !edgeArtifactVerification.step.run?.includes('python scripts/verify_serving_artifacts.py')
    || !edgeArtifactRegistration.step.run?.includes('python scripts/register_trusted_bundles.py')) {
  throw new Error('Production edge E2E must run the ordered persistence migrations and production RAG/model bootstrap before application startup');
}

const cd = parse(read('.github/workflows/cd.yml'));
const cdSteps = cd.jobs?.['deploy-and-verify-kind']?.steps || [];
const kindCluster = namedStep(cdSteps, 'Create Kind Kubernetes Cluster');
const productionValidatorDependencies = namedStep(cdSteps, 'Install production manifest validator dependencies');
const metricsServerInstall = namedStep(cdSteps, 'Install Metrics Server for HPA');
const imageBuild = namedStep(cdSteps, 'Build Docker Container Images');
if (kindCluster.step.with?.version !== 'v0.32.0'
    || kindCluster.step.with?.node_image !== 'kindest/node:v1.34.8@sha256:02722c2dedddcfc00febf5d27fbeb9b7b2c14294c82109ff4a85d89ac9ba3256'
    || !imageBuild.step.run?.includes("printf -- '- Commit: `%s`\\n' \"$RELEASE_SHA\"")
    || /echo\s+"[^"]*`/.test(imageBuild.step.run || '')
    || !metricsServerInstall.step.run?.includes('releases/download/v0.9.0/components.yaml')
    || !metricsServerInstall.step.run?.includes('1cec29a5267809306a2c6ec74a3e449abbb705b4a8beed0c8a1963910f72c79b')
    || !metricsServerInstall.step.run?.includes('sha256sum --check')
    || metricsServerInstall.step.run?.includes('metrics-server/releases/latest/')) {
  throw new Error('Kind CD must verify the pinned Metrics Server v0.9.0 manifest digest on a Kubernetes 1.34 node image');
}
const productionRenderValidation = namedStep(cdSteps, 'Render and validate fail-closed production image template');
if (!(productionValidatorDependencies.index < productionRenderValidation.index)
    || !productionValidatorDependencies.step.run?.includes('npm ci --prefix server')
    || !productionRenderValidation.step.run?.includes('kubectl kustomize deploy/production')
    || !productionRenderValidation.step.run?.includes('node server/scripts/validateProductionImageManifest.js --template')) {
  throw new Error('Kind CD must install the locked Node dependencies before rendering and validating the non-deployable production image template');
}
if (cdSteps.filter(step => step.name === 'Run the one-shot Phase 7 ResearchAgent task migration').length !== 1) {
  throw new Error('Kind CD must run exactly one Phase 7 ResearchAgent task migration');
}
const dbApply = namedStep(cdSteps, 'Apply database prerequisites');
const secrets = namedStep(cdSteps, 'Inject ephemeral secrets for Kind validation cluster');
const dbReady = namedStep(cdSteps, 'Wait for Database and Redis to be Ready');
const cdPhase2Migration = namedStep(cdSteps, 'Run the one-shot Phase 2 index migration');
const cdPhase3Migration = namedStep(cdSteps, 'Run the one-shot Phase 3 ML/RAG state migration');
const cdPhase4Migration = namedStep(cdSteps, 'Run the one-shot Phase 4 PlanReview persistence migration');
const cdPhase5Migration = namedStep(cdSteps, 'Run the one-shot Phase 5 durable agent runtime migration');
const cdPhase7Migration = namedStep(cdSteps, 'Run the one-shot Phase 7 ResearchAgent task migration');
const appApply = namedStep(cdSteps, 'Apply application manifests after database migrations');
const appReady = namedStep(cdSteps, 'Wait for Microservices to be Ready');
const liveSmoke = namedStep(cdSteps, 'Execute Live Smoke Tests & Prove Request Flow (Step 2)');
if (!(dbApply.index < secrets.index
    && secrets.index < dbReady.index
    && dbReady.index < cdPhase2Migration.index
    && cdPhase2Migration.index < cdPhase3Migration.index
    && cdPhase3Migration.index < cdPhase4Migration.index
    && cdPhase4Migration.index < cdPhase5Migration.index
    && cdPhase5Migration.index < cdPhase7Migration.index
    && cdPhase7Migration.index < appApply.index
    && appApply.index < appReady.index)
    || !cdPhase2Migration.step.run?.includes('k8s/phase2-index-migration/job.yaml')
    || !cdPhase2Migration.step.run?.includes('| kubectl create -f -')
    || !cdPhase2Migration.step.run?.includes('kubectl wait --for=condition=complete')
    || !cdPhase3Migration.step.run?.includes('k8s/phase3-state-migration/job.yaml')
    || !cdPhase3Migration.step.run?.includes('| kubectl create -f -')
    || !cdPhase3Migration.step.run?.includes('kubectl wait --for=condition=complete')
    || !cdPhase4Migration.step.run?.includes('k8s/phase4-plan-review-migration/job.yaml')
    || !cdPhase4Migration.step.run?.includes('| kubectl create -f -')
    || !cdPhase4Migration.step.run?.includes('kubectl wait --for=condition=complete')
    || !cdPhase5Migration.step.run?.includes('k8s/phase5-agent-runtime-migration/job.yaml')
    || !cdPhase5Migration.step.run?.includes('| kubectl create -f -')
    || !cdPhase5Migration.step.run?.includes('kubectl wait --for=condition=complete')
    || !cdPhase7Migration.step.run?.includes('k8s/phase7-research-task-migration.yaml')
    || !cdPhase7Migration.step.run?.includes('| kubectl create -f -')
    || !cdPhase7Migration.step.run?.includes('kubectl wait --for=condition=complete')
    || !appApply.step.run?.includes('kubectl kustomize k8s/')
    || !appApply.step.run?.includes('kubectl apply -f build/k8s-pinned.yaml')
    || !appApply.step.run?.includes('RELEASE_SHA')
    || !secrets.step.run?.includes('EPHEMERAL_REDIS_PASSWORD=$(openssl rand -hex 32)')
    || !secrets.step.run?.includes('--from-literal=REDIS_PASSWORD="$EPHEMERAL_REDIS_PASSWORD"')
    || !appReady.step.run?.includes('kubectl rollout status deployment/wealthgenie-agent-worker')
    || !(appReady.index < liveSmoke.index)
    || !liveSmoke.step.run?.includes('/health/verification')
    || !liveSmoke.step.run?.includes('transactionCapable')
    || !liveSmoke.step.run?.includes('environmentSentinelVerified')
    || !liveSmoke.step.run?.includes('redis?.connected')) {
  throw new Error('Kind CD must wait for all ordered one-shot database migrations before applying application workloads');
}

const tckManualRunner = read('scripts/run_a2a_tck.sh');
const pinnedTckSha = '263b9cfaf16a554bdfb166a7ba5b67716e946349';
const tckPolicy = JSON.parse(read('.github/a2a-tck-known-blockers.json'));
const expectedTckUntrackedPaths = [
  'reports/compatibility.html',
  'reports/compatibility.json',
  'reports/junitreport.xml',
  'reports/tck_report.html',
];
const expectedTckInventorySha256 = '62cedc3216bb27545d2ede0bb8cf6588ef893e2f827b1de2ac4104a215122028';
const tckTestCases = Array.isArray(tckPolicy.test_cases) ? tckPolicy.test_cases : [];
const sortedTckTestCases = [...tckTestCases].sort((left, right) => {
  const leftId = String(left?.junit_classname || '') + '::' + String(left?.junit_name || '');
  const rightId = String(right?.junit_classname || '') + '::' + String(right?.junit_name || '');
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
});
const tckInventoryCanonical = sortedTckTestCases
  .map(testCase => testCase.junit_classname + '::' + testCase.junit_name + '\t' + (testCase.expected_skip_reason || ''))
  .join('\n');
const tckInventoryHash = createHash('sha256').update(tckInventoryCanonical, 'utf8').digest('hex');
const tckTestCaseIds = new Set(sortedTckTestCases.map(testCase => testCase.junit_classname + '::' + testCase.junit_name));
const tckExpectedSkipCount = sortedTckTestCases.filter(testCase => typeof testCase.expected_skip_reason === 'string').length;
const expectedTckIssueClasses = {
  'https://github.com/a2aproject/a2a-tck/issues/202': 'MISSING_EXPECTED_ERROR_ASSERTION',
  'https://github.com/a2aproject/a2a-tck/issues/229': 'FIXTURE_APPLICABILITY',
};
const tckIssueClasses = Object.fromEntries(
  (Array.isArray(tckPolicy.upstream_issues) ? tckPolicy.upstream_issues : [])
    .map(issue => [issue?.url, issue?.classification]),
);
const tckCoreSendException = Array.isArray(tckPolicy.known_failures)
  ? tckPolicy.known_failures.find(testCase => testCase?.requirement_id === 'CORE-SEND-003')
  : null;
if (!tckManualRunner.includes(`tck_sha=${pinnedTckSha}`)
    || !tckManualRunner.includes('git -C "$tck_dir" fetch --depth 1 origin "$tck_sha"')
    || !tckManualRunner.includes('test "$(git -C "$tck_dir" rev-parse HEAD)" = "$tck_sha"')
    || !tckManualRunner.includes('git -C "$tck_dir" status --porcelain=v1 --untracked-files=all')
    || !tckManualRunner.includes('python run_tck.py --sut-host http://127.0.0.1:5088 --transport http_json --level must')
    || !tckManualRunner.includes('scripts/validate_a2a_tck_policy.py')
    || !tckManualRunner.includes('RAW_TCK_EXIT_CODE=%s')
    || !tckManualRunner.includes('--summary-path "$work_dir/summary.md"')
    || tckPolicy.tck_sha !== pinnedTckSha
    || tckPolicy.tck_repository !== 'a2aproject/a2a-tck'
    || tckPolicy.policy_schema_version !== 5
    || tckPolicy.classification !== 'KNOWN_UPSTREAM_TCK_EXCEPTIONS'
    || tckPolicy.test_case_count !== 235
    || tckPolicy.skipped_test_case_count !== 178
    || tckTestCases.length !== 235
    || tckTestCaseIds.size !== 235
    || tckExpectedSkipCount !== 178
    || tckPolicy.test_case_inventory_sha256 !== expectedTckInventorySha256
    || tckInventoryHash !== expectedTckInventorySha256
    || tckPolicy.test_inventory_evidence?.tck_sha !== pinnedTckSha
    || tckPolicy.test_inventory_evidence?.workflow_run_id !== 37421617732
    || tckPolicy.test_inventory_evidence?.workflow_head_sha !== '15454b98fa87ed29db7fd58eb21cbe29eb016678'
    || tckPolicy.test_inventory_evidence?.workflow_head_is_ancestor_of_current_main !== true
    || tckPolicy.test_inventory_evidence?.junit_report_sha256 !== '69b917d3c73c37c375c44b3a694ed7408b643733a7b271e67416a4b9c4f5ca4b'
    || tckPolicy.test_inventory_evidence?.collected_identity_match !== true
    || Object.keys(tckIssueClasses).length !== 2
    || Object.entries(expectedTckIssueClasses).some(([url, classification]) => tckIssueClasses[url] !== classification)
    || !Array.isArray(tckPolicy.known_failures)
    || tckPolicy.known_failures.length !== 6
    || tckPolicy.known_failures.filter(testCase => testCase?.upstream_issue === 'https://github.com/a2aproject/a2a-tck/issues/229').length !== 5
    || tckCoreSendException?.node_id !== 'tests/compatibility/core_operations/test_requirements.py::test_must_requirement[CORE-SEND-003-http_json]'
    || tckCoreSendException?.upstream_issue !== 'https://github.com/a2aproject/a2a-tck/issues/202'
    || !tckCoreSendException?.failure_signature?.includes('Operation failed: [400] Unsupported input media type "application/x-unsupported-tck-type"')
    || JSON.stringify(tckPolicy.acceptance?.allow_untracked_tck_paths) !== JSON.stringify(expectedTckUntrackedPaths)
    || tckPolicy.acceptance?.allow_test_errors !== false
    || tckPolicy.acceptance?.allow_tracked_tck_changes !== false
    || tckPolicy.acceptance?.allow_unknown_failures !== false
    || tckPolicy.acceptance?.allow_skipped_known_tests !== false) {
  throw new Error('A2A TCK manual runner must retain the pinned upstream suite and exact fail-closed exception policy');
}
console.log(`Validated ${deploymentFiles.length} deployment YAML files, fail-closed production image markers, ordered Phase 2/3/4/5/7 migrations in Browser CI, production-edge E2E and Kind CD, Compose API/worker separation, and worker probes.`);
