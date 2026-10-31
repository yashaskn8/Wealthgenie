import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('WG-009: Dockerfiles for server, reactapp, ml-service and root docker-compose.yml exist and are non-empty', () => {
  const rootDir = fs.existsSync(path.join(process.cwd(), 'docker-compose.yml'))
    ? process.cwd()
    : path.resolve(process.cwd(), '..');
  
  const dockerFiles = [
    path.join(rootDir, 'server', 'Dockerfile'),
    path.join(rootDir, 'server', '.dockerignore'),
    path.join(rootDir, '.dockerignore'),
    path.join(rootDir, 'reactapp', 'Dockerfile'),
    path.join(rootDir, 'reactapp', '.dockerignore'),
    path.join(rootDir, 'ml-service', 'Dockerfile'),
    path.join(rootDir, 'ml-service', '.dockerignore'),
    path.join(rootDir, 'docker-compose.yml'),
  ];

  for (const filePath of dockerFiles) {
    assert.ok(fs.existsSync(filePath), `Docker config missing: ${filePath}`);
    const stats = fs.statSync(filePath);
    const minimumSize = path.basename(filePath) === '.dockerignore' ? 1 : 50;
    assert.ok(stats.size > minimumSize, `Docker config file is empty/too small: ${filePath}`);
  }
});

test('Docker full-stack wiring proxies frontend API calls and supplies ML operator auth', () => {
  const rootDir = fs.existsSync(path.join(process.cwd(), 'docker-compose.yml'))
    ? process.cwd()
    : path.resolve(process.cwd(), '..');
  const frontendDockerfile = fs.readFileSync(path.join(rootDir, 'reactapp', 'Dockerfile'), 'utf8');
  const nginxConfig = fs.readFileSync(path.join(rootDir, 'reactapp', 'nginx.conf'), 'utf8');
  const composeConfig = fs.readFileSync(path.join(rootDir, 'docker-compose.yml'), 'utf8');
  const mongoService = fs.readFileSync(path.join(rootDir, 'k8s', 'mongodb', 'service.yaml'), 'utf8');

  assert.match(frontendDockerfile, /COPY\s+reactapp\/nginx\.conf\s+\/etc\/nginx\/conf\.d\/default\.conf/);
  assert.match(nginxConfig, /location\s+\/api\//);
  assert.match(nginxConfig, /proxy_pass\s+http:\/\/wealthgenie-server:5000;/);
  assert.match(composeConfig, /server:\s*\n\s+build:\s*\n\s+context:\s*\.\s*\n\s+dockerfile:\s*server\/Dockerfile/);
  assert.match(composeConfig, /agent-worker:\s*\n\s+build:\s*\n\s+context:\s*\.\s*\n\s+dockerfile:\s*server\/Dockerfile/);
  assert.match(composeConfig, /reactapp:\s*\n\s+build:\s*\n\s+context:\s*\.\s*\n\s+dockerfile:\s*reactapp\/Dockerfile/);
  assert.match(composeConfig, /aliases:[\s\S]*- wealthgenie-server/);
  assert.match(composeConfig, /ML_OPERATOR_KEY=\$\{ML_OPERATOR_KEY:-\}/);
  assert.match(composeConfig, /METRICS_TOKEN=\$\{METRICS_TOKEN:-\}/);
  assert.match(composeConfig, /NODE_ENV=development/);
  assert.match(composeConfig, /AUTH_COOKIE_SECURE=\$\{AUTH_COOKIE_SECURE:-false\}/);
  assert.match(composeConfig, /CORS_ORIGINS=\$\{CORS_ORIGINS:-http:\/\/localhost,http:\/\/127\.0\.0\.1\}/);
  assert.match(composeConfig, /MONGODB_URI=mongodb:\/\/mongodb:27017\/wealthgenie\?replicaSet=rs0/);
  assert.match(mongoService, /publishNotReadyAddresses:\s*true/);
});

test('Nginx permits same-origin microphone access while blocking unrelated sensitive browser features', () => {
  const rootDir = fs.existsSync(path.join(process.cwd(), 'docker-compose.yml'))
    ? process.cwd()
    : path.resolve(process.cwd(), '..');
  const nginxConfig = fs.readFileSync(path.join(rootDir, 'reactapp', 'nginx.conf'), 'utf8');
  const policy = nginxConfig.match(/add_header Permissions-Policy "([^"]+)" always;/)?.[1];

  assert.ok(policy, 'Permissions-Policy response header is missing');
  assert.match(policy, /(?:^|,\s*)microphone=\(self\)(?:,|$)/);
  assert.match(policy, /(?:^|,\s*)camera=\(\)(?:,|$)/);
  assert.match(policy, /(?:^|,\s*)geolocation=\(\)(?:,|$)/);
});

test('root-context application images include authoritative shared modules without host dependencies or env files', () => {
  const rootDir = fs.existsSync(path.join(process.cwd(), 'docker-compose.yml'))
    ? process.cwd()
    : path.resolve(process.cwd(), '..');
  const rootDockerignore = fs.readFileSync(path.join(rootDir, '.dockerignore'), 'utf8');
  const serverDockerfile = fs.readFileSync(path.join(rootDir, 'server', 'Dockerfile'), 'utf8');
  const frontendDockerfile = fs.readFileSync(path.join(rootDir, 'reactapp', 'Dockerfile'), 'utf8');

  for (const sharedFile of ['buildIdentity.js', 'demoPreflightContracts.js']) {
    assert.ok(fs.existsSync(path.join(rootDir, 'shared', sharedFile)), `Missing shared contract: ${sharedFile}`);
  }
  assert.match(rootDockerignore, /^!server\/\*\*$/m);
  assert.match(rootDockerignore, /^!reactapp\/\*\*$/m);
  assert.match(rootDockerignore, /^!shared\/buildIdentity\.js$/m);
  assert.match(rootDockerignore, /^!shared\/demoPreflightContracts\.js$/m);
  assert.match(rootDockerignore, /^server\/node_modules$/m);
  assert.match(rootDockerignore, /^reactapp\/node_modules$/m);
  assert.match(rootDockerignore, /^server\/\.env$/m);
  assert.match(rootDockerignore, /^server\/\.env\.\*$/m);
  assert.match(rootDockerignore, /^server\/\*\*\/\.env\*$/m);
  assert.match(rootDockerignore, /^reactapp\/\.env\*$/m);
  assert.match(rootDockerignore, /^reactapp\/\*\*\/\.env\*$/m);
  assert.match(serverDockerfile, /COPY\s+server\/package\*\.json\s+\.\//);
  assert.match(serverDockerfile, /COPY\s+server\/\.\s+\./);
  assert.match(serverDockerfile, /COPY\s+shared\s+\/shared/);
  assert.match(frontendDockerfile, /COPY\s+reactapp\/package\*\.json\s+\.\//);
  assert.match(frontendDockerfile, /COPY\s+reactapp\/\.\s+\./);
  assert.match(frontendDockerfile, /COPY\s+shared\s+\/shared/);
});

test('production edge timeout hierarchy is explicit and above the 90-second client deadline', () => {
  const rootDir = fs.existsSync(path.join(process.cwd(), 'docker-compose.yml'))
    ? process.cwd()
    : path.resolve(process.cwd(), '..');
  const nginxConfig = fs.readFileSync(path.join(rootDir, 'reactapp', 'nginx.conf'), 'utf8');
  const ingress = fs.readFileSync(path.join(rootDir, 'k8s', 'ingress.yaml'), 'utf8');
  const runtime = fs.readFileSync(path.join(rootDir, 'server', 'config', 'runtime.js'), 'utf8');
  assert.match(nginxConfig, /proxy_connect_timeout\s+10s/);
  assert.match(nginxConfig, /proxy_send_timeout\s+125s/);
  assert.match(nginxConfig, /proxy_read_timeout\s+125s/);
  assert.doesNotMatch(nginxConfig, /proxy_read_timeout\s+60s/);
  assert.match(ingress, /proxy-connect-timeout:\s*"10"/);
  assert.match(ingress, /proxy-send-timeout:\s*"130"/);
  assert.match(ingress, /proxy-read-timeout:\s*"130"/);
  assert.match(runtime, /requestTimeoutMs: positiveInteger\(env\.HTTP_REQUEST_TIMEOUT_MS, 120000/);
});

test('Docker build contexts exclude local secrets, caches, and host dependencies', () => {
  const rootDir = fs.existsSync(path.join(process.cwd(), 'docker-compose.yml'))
    ? process.cwd()
    : path.resolve(process.cwd(), '..');
  const serverIgnore = fs.readFileSync(path.join(rootDir, 'server', '.dockerignore'), 'utf8');
  const mlIgnore = fs.readFileSync(path.join(rootDir, 'ml-service', '.dockerignore'), 'utf8');

  assert.match(serverIgnore, /^node_modules$/m);
  assert.match(serverIgnore, /^\.env$/m);
  assert.match(mlIgnore, /^\.env$/m);
  assert.match(mlIgnore, /^\.venv$/m);
  assert.match(mlIgnore, /^__pycache__$/m);
});

test('production Nginx permits first-party microphone use while blocking other sensitive browser features', () => {
  const rootDir = fs.existsSync(path.join(process.cwd(), 'docker-compose.yml'))
    ? process.cwd()
    : path.resolve(process.cwd(), '..');
  const nginxConfig = fs.readFileSync(path.join(rootDir, 'reactapp', 'nginx.conf'), 'utf8');

  assert.match(nginxConfig, /Permissions-Policy[^\n]*microphone=\(self\)/);
  assert.doesNotMatch(nginxConfig, /Permissions-Policy[^\n]*microphone=\(\)/);
  assert.match(nginxConfig, /Permissions-Policy[^\n]*camera=\(\)/);
  assert.match(nginxConfig, /Permissions-Policy[^\n]*geolocation=\(\)/);
});

test('Kind image builds use repository-root contexts for shared-module Dockerfiles', () => {
  const rootDir = fs.existsSync(path.join(process.cwd(), 'docker-compose.yml'))
    ? process.cwd()
    : path.resolve(process.cwd(), '..');
  const cdWorkflow = fs.readFileSync(path.join(rootDir, '.github', 'workflows', 'cd.yml'), 'utf8');
  const buildStep = cdWorkflow.match(
    /- name: Build Docker Container Images[\s\S]*?(?=\n\s{6}- name:|$)/,
  )?.[0];

  assert.ok(buildStep, 'CD Docker image build step is missing');
  const commands = buildStep.replace(/\\\r?\n\s*/g, ' ');

  assert.match(commands, /docker build\s+--build-arg APP_BUILD_SHA="\$RELEASE_SHA"\s+-f server\/Dockerfile\s+-t "wealthgenie-server:\$IMAGE_TAG" -t wealthgenie-server:latest\s+\./);
  assert.match(commands, /docker build\s+-f ml-service\/Dockerfile -t "wealthgenie-ml-service:\$IMAGE_TAG"\s+-t wealthgenie-ml-service:latest ml-service\//);
  assert.match(commands, /docker build\s+--build-arg VITE_API_URL=\/api\s+--build-arg VITE_BUILD_SHA="\$RELEASE_SHA"\s+-f reactapp\/Dockerfile\s+-t "wealthgenie-frontend:\$IMAGE_TAG"/);
  assert.match(commands, /docker image inspect --format '\{\{\.Id\}\}' "wealthgenie-server:\$IMAGE_TAG"/);
  assert.match(commands, /docker cp "\$FRONTEND_CONTAINER:\/usr\/share\/nginx\/html\/\." build\/frontend-artifacts\//);
  assert.match(commands, /server\/scripts\/createBuildProvenance\.js/);
  assert.doesNotMatch(commands, /docker build\s+-t wealthgenie-server:latest\s+server\//);
  assert.doesNotMatch(commands, /docker build\s+--build-arg VITE_API_URL=\/api\s+--build-arg VITE_BUILD_SHA=\$\{\{\s*github\.sha\s*\}\}\s+-t wealthgenie-frontend:latest\s+reactapp\//);
  assert.match(cdWorkflow, /kind load docker-image "wealthgenie-server:\$IMAGE_TAG"/);
  assert.match(cdWorkflow, /sed -E "s\/\(wealthgenie-\(server\|frontend\|ml-service\)\):latest/);
  assert.match(cdWorkflow, /kubectl create configmap wealthgenie-build-provenance/);
  assert.match(cdWorkflow, /verify_deployed_image_identity wealthgenie-server/);
  assert.match(cdWorkflow, /verify_deployed_image_identity wealthgenie-agent-worker/);
  assert.match(cdWorkflow, /verify_deployed_image_identity wealthgenie-frontend/);
  assert.match(cdWorkflow, /verify_deployed_image_identity wealthgenie-ml-service/);
  assert.match(cdWorkflow, /crictl inspecti/);
  assert.match(cdWorkflow, /\.status\.repoDigests/);
  assert.match(cdWorkflow, /\.status\.containerStatuses\[\]\?\.imageID/);
});

test('Kubernetes serves the same optional build provenance manifest from backend health and frontend static files', () => {
  const rootDir = fs.existsSync(path.join(process.cwd(), 'docker-compose.yml'))
    ? process.cwd()
    : path.resolve(process.cwd(), '..');
  const serverDeployment = fs.readFileSync(path.join(rootDir, 'k8s', 'server', 'deployment.yaml'), 'utf8');
  const frontendDeployment = fs.readFileSync(path.join(rootDir, 'k8s', 'frontend', 'deployment.yaml'), 'utf8');
  const healthRoute = fs.readFileSync(path.join(rootDir, 'server', 'routes', 'health.js'), 'utf8');
  const demoPreflight = fs.readFileSync(path.join(rootDir, 'server', 'scripts', 'demoPreflight.js'), 'utf8');

  assert.match(serverDeployment, /APP_BUILD_PROVENANCE_PATH[\s\S]*\/run\/wealthgenie\/build-provenance\/provenance\.json/);
  assert.match(serverDeployment, /mountPath: \/run\/wealthgenie\/build-provenance/);
  assert.match(frontendDeployment, /mountPath: \/usr\/share\/nginx\/html\/build-provenance/);
  assert.match(serverDeployment, /name: wealthgenie-build-provenance[\s\S]*optional: true/);
  assert.match(frontendDeployment, /name: wealthgenie-build-provenance[\s\S]*optional: true/);
  assert.match(healthRoute, /buildProvenance: publicBuildProvenance\(buildProvenance\)/);
  assert.match(demoPreflight, /build-provenance\/provenance\.json/);
});

test('Kubernetes supplies every production ML credential using the expected variable names', () => {
  const rootDir = fs.existsSync(path.join(process.cwd(), 'docker-compose.yml'))
    ? process.cwd()
    : path.resolve(process.cwd(), '..');
  const mlDeployment = fs.readFileSync(path.join(rootDir, 'k8s', 'ml-service', 'deployment.yaml'), 'utf8');
  const serverDeployment = fs.readFileSync(path.join(rootDir, 'k8s', 'server', 'deployment.yaml'), 'utf8');
  const secretExample = fs.readFileSync(path.join(rootDir, 'k8s', 'secrets.example.yaml'), 'utf8');
  const configMap = fs.readFileSync(path.join(rootDir, 'k8s', 'configmap.yaml'), 'utf8');
  const kustomization = fs.readFileSync(path.join(rootDir, 'k8s', 'kustomization.yaml'), 'utf8');
  const cdWorkflow = fs.readFileSync(path.join(rootDir, '.github', 'workflows', 'cd.yml'), 'utf8');

  assert.match(mlDeployment, /name:\s*ML_OPERATOR_KEY[\s\S]*key:\s*ML_OPERATOR_KEY/);
  assert.match(secretExample, /^\s*ML_OPERATOR_KEY:\s*"CHANGE_ME_ML_OPERATOR_KEY"/m);
  assert.match(serverDeployment, /name:\s*METRICS_TOKEN[\s\S]*key:\s*METRICS_TOKEN/);
  assert.match(secretExample, /^\s*METRICS_TOKEN:\s*"CHANGE_ME_METRICS_TOKEN/m);
  assert.match(configMap, /^\s*CORS_ORIGINS:\s*"https:\/\//m);
  assert.doesNotMatch(kustomization, /secrets\.example\.yaml/);
  assert.match(cdWorkflow, /--from-literal=ML_OPERATOR_KEY="\$EPHEMERAL_ML_OPERATOR_KEY"/);
  assert.match(cdWorkflow, /EPHEMERAL_ML_KEY=\$\(openssl rand -hex 32\)/);
  assert.match(cdWorkflow, /EPHEMERAL_ML_OPERATOR_KEY=\$\(openssl rand -hex 32\)/);
  assert.match(cdWorkflow, /--from-literal=METRICS_TOKEN="\$EPHEMERAL_METRICS_TOKEN"/);
  assert.match(cdWorkflow, /MONGODB_URI="mongodb:\/\/wealthgenie-mongodb[^"\s]+\?replicaSet=rs0"/);
});

test('Kind smoke verification owns and cleans up its server port-forward', () => {
  const rootDir = fs.existsSync(path.join(process.cwd(), 'docker-compose.yml'))
    ? process.cwd()
    : path.resolve(process.cwd(), '..');
  const cdWorkflow = fs.readFileSync(path.join(rootDir, '.github', 'workflows', 'cd.yml'), 'utf8');
  const smokeStep = cdWorkflow.match(
    /- name: Execute Live Smoke Tests & Prove Request Flow \(Step 2\)[\s\S]*?(?=\n\s{6}- name:|$)/,
  )?.[0];

  assert.ok(smokeStep, 'Kind live smoke step is missing');
  assert.match(smokeStep, /kubectl port-forward[^\n]+svc\/wealthgenie-server 5000:5000/);
  assert.match(smokeStep, /PORT_FORWARD_PID=\$!/);
  assert.match(smokeStep, /trap 'kill "\$PORT_FORWARD_PID"[^\n]+EXIT/);
  assert.match(smokeStep, /for attempt in \$\(seq 1 "\$attempts"\)/);
  assert.match(smokeStep, /curl[^\n]*--connect-timeout 5[^\n]*--max-time 10/);
  assert.match(smokeStep, /jq -e --arg expected "\$RELEASE_SHA" '\.buildSha == \$expected'/);
  assert.match(smokeStep, /http:\/\/127\.0\.0\.1:8080\/build-provenance\/provenance\.json > build\/frontend-provenance\.json/);
  assert.match(smokeStep, /build\/frontend-provenance\.json > \/dev\/null/);
  assert.match(smokeStep, /TAX_RES=\$\(curl[\s\S]*?--max-time 10[\s\S]*?"\$TAX_URL"\)/);
  assert.match(smokeStep, /TAX_URL="http:\/\/127\.0\.0\.1:5000\/api\/tax\/new-regime-verified"/);
  assert.match(smokeStep, /TAX_BODY='\{"taxYear":"2026-27","incomeType":"salary","primaryIncome":"1275000.00","otherOrdinaryIncome":"0","residency":"resident","specialRateIncome":"no","confirmedOrdinaryOnly":true\}'/);
  assert.match(smokeStep, /--request POST[\s\S]*?--header 'Content-Type: application\/json'[\s\S]*?--data "\$TAX_BODY" "\$TAX_URL"/);
  assert.doesNotMatch(smokeStep, /TAX_URL=.*income=/);
  assert.doesNotMatch(cdWorkflow, /- name: Port-Forward Express Server for Live Request Verification/);
});

test('Kind CD runs a provenance-bound, isolated Phase 15 pre-mutation doctor and complete live preflight', () => {
  const rootDir = fs.existsSync(path.join(process.cwd(), 'docker-compose.yml'))
    ? process.cwd()
    : path.resolve(process.cwd(), '..');
  const cdWorkflow = fs.readFileSync(path.join(rootDir, '.github', 'workflows', 'cd.yml'), 'utf8');
  const rootGitignore = fs.readFileSync(path.join(rootDir, '.gitignore'), 'utf8');
  const databaseStep = cdWorkflow.match(
    /- name: Provision isolated Phase 15 demo database sentinel[\s\S]*?(?=\n\s{6}- name:|$)/,
  )?.[0];
  const liveStep = cdWorkflow.match(
    /- name: Execute complete Phase 15 live preflight against the attested Kind deployment[\s\S]*?(?=\n\s{6}- name:|$)/,
  )?.[0];
  const tlsStep = cdWorkflow.match(
    /- name: Create and trust ephemeral Phase 15 loopback TLS identity[\s\S]*?(?=\n\s{6}- name:|$)/,
  )?.[0];
  const bindStep = cdWorkflow.match(
    /- name: Bind server to the verified Phase 15 demo database identity[\s\S]*?(?=\n\s{6}- name:|$)/,
  )?.[0];

  assert.ok(databaseStep, 'isolated Phase 15 demo database sentinel provisioning is missing');
  assert.ok(liveStep, 'complete Phase 15 live preflight step is missing');
  assert.ok(tlsStep, 'trusted ephemeral TLS setup is missing');
  assert.ok(bindStep, 'verified database and browser-origin binding is missing');
  assert.match(cdWorkflow, /MONGODB_URI="mongodb:\/\/wealthgenie-mongodb[^"\s]+\/wealthgenie-ci-demo\?replicaSet=rs0"/);
  assert.match(databaseStep, /hello\.setName !== 'rs0'/);
  assert.match(databaseStep, /hello\.isWritablePrimary !== true/);
  assert.match(databaseStep, /hello\.me !== '\$DEMO_MONGO_HOST:\$DEMO_MONGO_PORT'/);
  assert.match(databaseStep, /listDatabases: 1/);
  assert.match(databaseStep, /refusing to reuse prior data/);
  assert.match(databaseStep, /_id: 'wealthgenie-phase15-demo'/);
  assert.match(cdWorkflow, /DEMO_EXPECTED_MONGODB_ENVIRONMENT_ID=\$DEMO_ENVIRONMENT_ID/);
  assert.match(liveStep, /DEMO_EXPECTED_BUILD_SHA: \$\{\{ env\.RELEASE_SHA \}\}/);
  assert.match(liveStep, /DEMO_EXPECTED_BUILD_TREE_SHA: \$\{\{ steps\.build\.outputs\.git_tree_sha \}\}/);
  assert.match(liveStep, /DEMO_EXPECTED_BUILD_PROVENANCE_SHA256: \$\{\{ steps\.build\.outputs\.provenance_sha256 \}\}/);
  assert.match(liveStep, /DEMO_EXPECTED_FRONTEND_ARTIFACT_SET_SHA256: \$\{\{ steps\.build\.outputs\.frontend_artifact_set_sha256 \}\}/);
  assert.match(liveStep, /EXPECTED_SERVER_IMAGE_ID: \$\{\{ steps\.build\.outputs\.server_image_id \}\}/);
  assert.match(liveStep, /EXPECTED_FRONTEND_IMAGE_ID: \$\{\{ steps\.build\.outputs\.frontend_image_id \}\}/);
  assert.match(liveStep, /EXPECTED_ML_IMAGE_ID: \$\{\{ steps\.build\.outputs\.ml_image_id \}\}/);
  assert.match(liveStep, /node server\/scripts\/runPhase15CiPreflight\.js/);
  assert.match(liveStep, /DEMO_API_BASE_URL: https:\/\/127\.0\.0\.1:8443\/api/);
  assert.match(liveStep, /DEMO_FRONTEND_URL: https:\/\/127\.0\.0\.1:8443/);
  assert.match(liveStep, /NODE_EXTRA_CA_CERTS: \$\{\{ steps\.phase15-tls\.outputs\.ca_path \}\}/);
  assert.match(liveStep, /node server\/scripts\/phase15LoopbackTlsProxy\.js/);
  assert.match(liveStep, /trap 'kill "\$SERVER_PORT_FORWARD_PID" "\$FRONTEND_PORT_FORWARD_PID"/);
  assert.match(liveStep, /set -euo pipefail/);
  assert.doesNotMatch(liveStep, /continue-on-error:/);
  assert.match(tlsStep, /openssl verify -CAfile/);
  assert.match(tlsStep, /sudo apt-get install --no-install-recommends -y libnss3-tools/);
  assert.match(tlsStep, /certutil -N --empty-password -d "sql:\$NSS_DB"/);
  assert.match(tlsStep, /certutil -A -d "sql:\$NSS_DB" -n wealthgenie-phase15-ci -t 'C,,' -i "\$CERT_DIR\/ca\.crt"/);
  assert.match(tlsStep, /certutil -L -d "sql:\$NSS_DB" -n wealthgenie-phase15-ci/);
  assert.match(tlsStep, /certutil -A -d "sql:\$NSS_DB" -n wealthgenie-phase15-ci-server -t ',,' -i "\$CERT_DIR\/server\.crt"/);
  assert.match(tlsStep, /certutil -V -d "sql:\$NSS_DB" -n wealthgenie-phase15-ci-server -u V/);
  assert.doesNotMatch(`${tlsStep}\n${liveStep}`, /--ignore-certificate-errors|ignoreHTTPSErrors/);
  assert.match(tlsStep, /sudo update-ca-certificates/);
  assert.match(tlsStep, /origin=https:\/\/127\.0\.0\.1:8443/);
  assert.match(bindStep, /CORS_ORIGINS=\$DEMO_BROWSER_ORIGIN/);
  assert.doesNotMatch(liveStep, /curl[^\n]*\s-k(?:\s|$)/);
  assert.match(rootGitignore, /^\/build\/$/m, 'CI-generated provenance and rendered manifests must not dirty the checked-out source tree');
});

test('Kind HPA verification owns a separate port-forward and uses a valid tax contract', () => {
  const rootDir = fs.existsSync(path.join(process.cwd(), 'docker-compose.yml'))
    ? process.cwd()
    : path.resolve(process.cwd(), '..');
  const cdWorkflow = fs.readFileSync(path.join(rootDir, '.github', 'workflows', 'cd.yml'), 'utf8');
  const hpaStep = cdWorkflow.match(
    /- name: Verify Horizontal Pod Autoscaler & Load Response \(Step 3\)[\s\S]*?(?=\n\s{6}- name:|$)/,
  )?.[0];

  assert.ok(hpaStep, 'Kind HPA verification step is missing');
  assert.match(hpaStep, /kubectl port-forward[^\n]+svc\/wealthgenie-server 5000:5000/);
  assert.match(hpaStep, /HPA_PORT_FORWARD_PID=\$!/);
  assert.match(hpaStep, /LOAD_URL="http:\/\/127\.0\.0\.1:5000\/api\/tax\/new-regime-verified"/);
  assert.match(hpaStep, /TAX_BODY='\{"taxYear":"2026-27","incomeType":"salary","primaryIncome":"1275000.00","otherOrdinaryIncome":"0","residency":"resident","specialRateIncome":"no","confirmedOrdinaryOnly":true\}'/);
  assert.match(hpaStep, /--request POST[\s\S]*?--data "\$TAX_BODY" "\$LOAD_URL"/);
  assert.match(hpaStep, /autocannon[^\n]+-m POST[^\n]+-b "\$TAX_BODY" "\$LOAD_URL"/);
  assert.doesNotMatch(hpaStep, /LOAD_URL=.*income=/);
  assert.match(hpaStep, /kubectl top pods[^\n]+--no-headers/);
  assert.match(hpaStep, /currentMetrics\[0\]\.resource\.current\.averageUtilization/);
});

test('ML Docker build verifies pre-generated artifacts and never trains', () => {
  const rootDir = fs.existsSync(path.join(process.cwd(), 'docker-compose.yml'))
    ? process.cwd()
    : path.resolve(process.cwd(), '..');
  const dockerfile = fs.readFileSync(path.join(rootDir, 'ml-service', 'Dockerfile'), 'utf8');

  assert.match(dockerfile, /RUN python scripts\/verify_serving_artifacts\.py/);
  assert.doesNotMatch(dockerfile, /RUN python -m model\.training\./);
  assert.doesNotMatch(dockerfile, /train(?:_pytorch)?[^\n]*\|\|\s*true/);
});
