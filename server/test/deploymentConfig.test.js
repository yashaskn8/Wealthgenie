import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const validatorPath = path.join(repositoryRoot, 'server/scripts/validate-deployment-config.js');
const productionImageValidatorPath = path.join(repositoryRoot, 'server/scripts/validateProductionImageManifest.js');

function withDeploymentFixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wealthgenie-deployment-contract-'));
  try {
    fs.cpSync(path.join(repositoryRoot, '.github/workflows'), path.join(root, '.github/workflows'), { recursive: true });
    fs.copyFileSync(path.join(repositoryRoot, '.github/a2a-tck-known-blockers.json'), path.join(root, '.github/a2a-tck-known-blockers.json'));
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.copyFileSync(path.join(repositoryRoot, 'scripts/run_a2a_tck.sh'), path.join(root, 'scripts/run_a2a_tck.sh'));
    fs.cpSync(path.join(repositoryRoot, 'k8s'), path.join(root, 'k8s'), { recursive: true });
    fs.cpSync(path.join(repositoryRoot, 'deploy'), path.join(root, 'deploy'), { recursive: true });
    fs.copyFileSync(path.join(repositoryRoot, 'docker-compose.yml'), path.join(root, 'docker-compose.yml'));
    return run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function validate(root) {
  return spawnSync(process.execPath, [validatorPath], {
    encoding: 'utf8',
    env: { ...process.env, WEALTHGENIE_VALIDATION_ROOT: root },
    timeout: 15000,
  });
}

function readYaml(root, relativePath) {
  return parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

function writeYaml(root, relativePath, value) {
  fs.writeFileSync(path.join(root, relativePath), stringify(value), 'utf8');
}

test('production rendered manifests reject mutable WealthGenie application image references', () => {
  const manifest = [
    'apiVersion: apps/v1',
    'kind: Deployment',
    'metadata: { name: wealthgenie-server }',
    'spec:',
    '  template:',
    '    spec:',
    '      containers:',
    '        - name: server',
    '          image: wealthgenie-server:latest',
    '---',
    'apiVersion: apps/v1',
    'kind: Deployment',
    'metadata: { name: wealthgenie-frontend }',
    'spec:',
    '  template:',
    '    spec:',
    '      containers:',
    '        - name: frontend',
    '          image: wealthgenie-frontend:latest',
    '---',
    'apiVersion: apps/v1',
    'kind: Deployment',
    'metadata: { name: wealthgenie-ml-service }',
    'spec:',
    '  template:',
    '    spec:',
    '      containers:',
    '        - name: ml-service',
    '          image: wealthgenie-ml-service:latest',
  ].join('\n');
  const result = spawnSync(process.execPath, [productionImageValidatorPath], {
    encoding: 'utf8',
    input: manifest,
    timeout: 15000,
  });

  assert.notEqual(result.status, 0, 'mutable app references must never pass production render validation');
  assert.match(result.stderr, /IMMUTABLE_REGISTRY_DIGEST/i);
  assert.equal(result.stdout, '', 'invalid manifests must not be emitted to an apply pipeline');
});

test('production image filter accepts fully qualified registry digests for every rendered image', () => {
  const images = [
    ['wealthgenie-server', 'ghcr.io/yashaskn8/wealthgenie-server'],
    ['wealthgenie-frontend', 'ghcr.io/yashaskn8/wealthgenie-frontend'],
    ['wealthgenie-ml-service', 'ghcr.io/yashaskn8/wealthgenie-ml-service'],
    ['redis', 'docker.io/library/redis'],
  ];
  const manifest = images.map(([name, repository], index) => {
    const digest = String(index + 1).repeat(64);
    return [
      'apiVersion: apps/v1',
      'kind: Deployment',
      `metadata: { name: ${name} }`,
      'spec:',
      '  template:',
      '    spec:',
      '      containers:',
      `        - { name: app, image: ${repository}@sha256:${digest} }`,
    ].join('\n');
  }).join('\n---\n');
  const result = spawnSync(process.execPath, [productionImageValidatorPath], {
    encoding: 'utf8',
    input: manifest,
    timeout: 15000,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, manifest);
});

test('production image filter rejects unapproved repositories for every required image', () => {
  const images = [
    ['wealthgenie-server', 'ghcr.io/yashaskn8/wealthgenie-server'],
    ['wealthgenie-frontend', 'ghcr.io/yashaskn8/wealthgenie-frontend'],
    ['wealthgenie-ml-service', 'ghcr.io/yashaskn8/wealthgenie-ml-service'],
    ['redis', 'docker.io/library/redis'],
  ];

  for (const [name] of images) {
    const manifest = `apiVersion: batch/v1\nkind: Job\nspec:\n  template:\n    spec:\n      containers:\n        - { name: migration, image: attacker.example/any-owner/${name}@sha256:${'a'.repeat(64)} }\n      restartPolicy: Never\n`;
    const result = spawnSync(process.execPath, [productionImageValidatorPath, '--fragment'], {
      encoding: 'utf8',
      input: manifest,
      timeout: 15000,
    });

    assert.notEqual(result.status, 0, `${name} must use its approved repository path`);
    assert.match(result.stderr, /UNAPPROVED_PRODUCTION_IMAGE_REPOSITORY/);
    assert.equal(result.stdout, '', 'invalid manifests must not be emitted to an apply pipeline');
  }
});

test('production image filter rejects each missing application or infrastructure image', () => {
  const images = [
    ['wealthgenie-server', 'ghcr.io/yashaskn8/wealthgenie-server'],
    ['wealthgenie-frontend', 'ghcr.io/yashaskn8/wealthgenie-frontend'],
    ['wealthgenie-ml-service', 'ghcr.io/yashaskn8/wealthgenie-ml-service'],
    ['redis', 'docker.io/library/redis'],
  ];

  for (const [missingName] of images) {
    const manifest = images
      .filter(([name]) => name !== missingName)
      .map(([, repository], index) => {
        const digest = String(index + 1).repeat(64);
        return `apiVersion: apps/v1\nkind: Deployment\nspec:\n  template:\n    spec:\n      containers:\n        - { name: app, image: ${repository}@sha256:${digest} }\n`;
      })
      .join('---\n');
    const result = spawnSync(process.execPath, [productionImageValidatorPath], {
      encoding: 'utf8',
      input: manifest,
      timeout: 15000,
    });

    assert.notEqual(result.status, 0, `${missingName} must be required in a production render`);
    assert.match(result.stderr, new RegExp(`(?:APPLICATION|INFRASTRUCTURE)_IMAGE_MISSING:${missingName}`));
    assert.equal(result.stdout, '', 'invalid manifests must not be emitted to an apply pipeline');
  }
});

test('production image filter also rejects mutable database and cache image references', () => {
  const manifest = [
    ...['server', 'frontend', 'ml-service'].map((component, index) => {
      const image = `wealthgenie-${component}`;
      const digest = String(index + 1).repeat(64);
      return `apiVersion: apps/v1\nkind: Deployment\nspec:\n  template:\n    spec:\n      containers:\n        - { name: app, image: ghcr.io/yashaskn8/${image}@sha256:${digest} }\n`;
    }),
    'apiVersion: apps/v1\nkind: Deployment\nspec:\n  template:\n    spec:\n      containers:\n        - { name: redis, image: redis:7.2-alpine }\n',
  ].join('---\n');
  const result = spawnSync(process.execPath, [productionImageValidatorPath], {
    encoding: 'utf8',
    input: manifest,
    timeout: 15000,
  });

  assert.notEqual(result.status, 0, 'every production container image must be pinned by registry digest');
  assert.match(result.stderr, /IMMUTABLE_REGISTRY_DIGEST/i);
  assert.equal(result.stdout, '', 'invalid manifests must not be emitted to an apply pipeline');
});

test('production image filter rejects in-cluster MongoDB images', () => {
  const images = [
    ['wealthgenie-server', 'ghcr.io/yashaskn8/wealthgenie-server'],
    ['wealthgenie-frontend', 'ghcr.io/yashaskn8/wealthgenie-frontend'],
    ['wealthgenie-ml-service', 'ghcr.io/yashaskn8/wealthgenie-ml-service'],
    ['redis', 'docker.io/library/redis'],
    ['mongo', 'docker.io/library/mongo'],
  ];
  const manifest = images.map(([name, repository], index) => {
    const digest = String(index + 1).repeat(64);
    return `apiVersion: apps/v1\nkind: Deployment\nmetadata: { name: ${name} }\nspec:\n  template:\n    spec:\n      containers:\n        - { name: app, image: ${repository}@sha256:${digest} }\n`;
  }).join('---\n');
  const result = spawnSync(process.execPath, [productionImageValidatorPath], {
    encoding: 'utf8',
    input: manifest,
    timeout: 15000,
  });

  assert.notEqual(result.status, 0, 'production must use external DocumentDB instead of an in-cluster MongoDB image');
  assert.match(result.stderr, /IN_CLUSTER_MONGODB_NOT_ALLOWED_IN_PRODUCTION/);
  assert.equal(result.stdout, '', 'invalid manifests must not be emitted to an apply pipeline');
});

test('production template filter accepts only the checked-in non-deployable image markers', () => {
  const images = [
    ['wealthgenie-server', 'SERVER'],
    ['wealthgenie-frontend', 'FRONTEND'],
    ['wealthgenie-ml-service', 'ML_SERVICE'],
    ['redis', 'REDIS'],
  ];
  const manifest = images.map(([name, markerName]) => {
    const marker = `WEALTHGENIE_${markerName}_IMAGE_DIGEST_REQUIRED`;
    return `apiVersion: apps/v1\nkind: Deployment\nspec:\n  template:\n    spec:\n      containers:\n        - { name: app, image: registry-required.invalid/${name}@sha256:${marker} }\n`;
  }).join('---\n');
  const result = spawnSync(process.execPath, [productionImageValidatorPath, '--template'], {
    encoding: 'utf8',
    input: manifest,
    timeout: 15000,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, manifest);

  const withInClusterMongo = `${manifest}\n---\napiVersion: apps/v1\nkind: Deployment\nspec:\n  template:\n    spec:\n      containers:\n        - { name: mongo, image: registry-required.invalid/mongo@sha256:${'0'.repeat(64)} }\n`;
  const mongoResult = spawnSync(process.execPath, [productionImageValidatorPath, '--template'], {
    encoding: 'utf8',
    input: withInClusterMongo,
    timeout: 15000,
  });

  assert.notEqual(mongoResult.status, 0, 'production templates must use external DocumentDB instead of in-cluster MongoDB');
  assert.match(mongoResult.stderr, /UNEXPECTED_PRODUCTION_TEMPLATE_IMAGE:mongo/);
  assert.equal(mongoResult.stdout, '', 'invalid templates must not be emitted to an apply pipeline');
});

test('Kind CD uses a containerd-v4-compatible release and verifies the fixed Metrics Server manifest digest', () => {
  const workflow = fs.readFileSync(path.join(repositoryRoot, '.github/workflows/cd.yml'), 'utf8');
  const parsed = parse(workflow);
  const steps = parsed.jobs['deploy-and-verify-kind'].steps;
  const build = steps.find(step => step.name === 'Build Docker Container Images');
  const terraformValidation = steps.find(step => step.name === 'Validate Terraform IaC');
  assert.match(workflow, /version:\s*v0\.32\.0/);
  assert.match(terraformValidation.run, /TERRAFORM_VALIDATION_DIR="\$\(mktemp -d\)"/,
    'Terraform dependency initialization must happen in an isolated disposable directory');
  assert.match(terraformValidation.run, /cp -a terraform\/\. "\$TERRAFORM_VALIDATION_DIR\/"/,
    'Terraform validation must use a copy so provider lock updates cannot dirty the attested source checkout');
  assert.match(terraformValidation.run, /terraform -chdir="\$TERRAFORM_VALIDATION_DIR" init -backend=false\n/,
    'Terraform must resolve and verify provider packages in the isolated copy');
  assert.match(terraformValidation.run, /terraform -chdir="\$TERRAFORM_VALIDATION_DIR" init -backend=false -lockfile=readonly/,
    'the resolved provider selections must be rechecked with a read-only lockfile');
  assert.match(terraformValidation.run, /terraform -chdir="\$TERRAFORM_VALIDATION_DIR" validate/);
  assert.equal(parsed.jobs['deploy-and-verify-kind'].steps
    .find(step => step.name === 'Create Kind Kubernetes Cluster').with.node_image, 'kindest/node:v1.34.8@sha256:02722c2dedddcfc00febf5d27fbeb9b7b2c14294c82109ff4a85d89ac9ba3256');
  assert.match(build.run, /printf -- '- Commit: `%s`\\n' "\$GITHUB_SHA"/);
  assert.doesNotMatch(build.run, /echo\s+"[^"]*`/, 'Markdown backticks must not trigger shell command substitution');
  assert.match(workflow, /releases\/download\/v0\.9\.0\/components\.yaml/);
  assert.match(workflow, /1cec29a5267809306a2c6ec74a3e449abbb705b4a8beed0c8a1963910f72c79b/);
  assert.match(workflow, /sha256sum --check/);
  assert.doesNotMatch(workflow, /metrics-server\/releases\/latest\//);
});

test('deployment validator rejects a changed Metrics Server manifest digest', () => {
  withDeploymentFixture(root => {
    const workflowPath = '.github/workflows/cd.yml';
    const workflow = readYaml(root, workflowPath);
    const install = workflow.jobs['deploy-and-verify-kind'].steps
      .find(step => step.name === 'Install Metrics Server for HPA');
    install.run = install.run.replace('1cec29a5267809306a2c6ec74a3e449abbb705b4a8beed0c8a1963910f72c79b', '0'.repeat(64));
    writeYaml(root, workflowPath, workflow);

    const result = validate(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /verify the pinned Metrics Server v0\.9\.0 manifest digest/);
  });
});

test('deployment validator rejects mutable Metrics Server latest downloads', () => {
  withDeploymentFixture(root => {
    const workflowPath = '.github/workflows/cd.yml';
    const workflow = readYaml(root, workflowPath);
    const install = workflow.jobs['deploy-and-verify-kind'].steps
      .find(step => step.name === 'Install Metrics Server for HPA');
    install.run = install.run.replace(
      'releases/download/v0.9.0/components.yaml',
      'releases/latest/download/components.yaml',
    );
    writeYaml(root, workflowPath, workflow);

    const result = validate(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /verify the pinned Metrics Server v0\.9\.0 manifest digest/);
  });
});

test('production image filter rejects local image IDs, tags, and loopback registries in migration manifests', () => {
  for (const image of [
    'sha256:' + 'a'.repeat(64),
    'wealthgenie-server:15454b98',
    `localhost:5000/org/wealthgenie-server@sha256:${'a'.repeat(64)}`,
    `127.0.0.1:5000/org/wealthgenie-server@sha256:${'a'.repeat(64)}`,
    `registry-required.invalid/wealthgenie-server@sha256:${'a'.repeat(64)}`,
  ]) {
    const manifest = `apiVersion: batch/v1\nkind: Job\nspec:\n  template:\n    spec:\n      containers:\n        - { name: migration, image: ${image} }\n      restartPolicy: Never\n`;
    const result = spawnSync(process.execPath, [productionImageValidatorPath, '--fragment'], {
      encoding: 'utf8',
      input: manifest,
      timeout: 15000,
    });
    assert.notEqual(result.status, 0, `${image} must not count as a production registry digest`);
    assert.match(result.stderr, /IMMUTABLE_REGISTRY_DIGEST|DOCKER_IMAGE_ID_IS_NOT_A_REGISTRY_REFERENCE/i);
    assert.equal(result.stdout, '');
  }
});

test('deployment validator accepts the complete ordered Phase 2 through Phase 7 migration sequence', () => {
  const result = validate(repositoryRoot);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ordered Phase 2\/3\/4\/5\/7 migrations/);
});

test('production overlay substitutes every image with an unusable digest-required sentinel', () => {
  const overlay = readYaml(repositoryRoot, 'deploy/production/kustomization.yaml');
  const images = new Map((overlay.images || []).map(image => [image.name, image]));
  const expectedImages = [
    ['wealthgenie-server', 'SERVER'],
    ['wealthgenie-frontend', 'FRONTEND'],
    ['wealthgenie-ml-service', 'ML_SERVICE'],
    ['redis', 'REDIS'],
  ];
  assert.equal(images.size, expectedImages.length);
  for (const [name, markerName] of expectedImages) {
    const image = images.get(name);
    assert.ok(image, `production overlay must transform ${name}`);
    assert.equal(image.newName, `registry-required.invalid/${name}`);
    assert.equal(image.digest, `sha256:WEALTHGENIE_${markerName}_IMAGE_DIGEST_REQUIRED`);
    assert.equal(image.newTag, undefined, 'a tag is not an immutable production identity');
  }
});

test('Kind CD renders the external production overlay with Kustomize before validating its template', () => {
  const workflow = readYaml(repositoryRoot, '.github/workflows/cd.yml');
  const steps = workflow.jobs['deploy-and-verify-kind'].steps;
  const dependencies = steps
    .find(step => step.name === 'Install production manifest validator dependencies');
  const render = steps
    .find(step => step.name === 'Render and validate fail-closed production image template');
  const overlay = readYaml(repositoryRoot, 'deploy/production/kustomization.yaml');

  assert.ok(dependencies, 'the clean CD runner must install the validator package dependencies');
  assert.ok(steps.indexOf(dependencies) < steps.indexOf(render), 'dependency installation must precede validator execution');
  assert.match(dependencies.run, /^npm ci --prefix server$/);
  assert.deepEqual(overlay.resources, ['../../k8s'], 'the overlay must reference the base without containing it');
  const mongoRemovalPatches = overlay.patches.filter(patch => patch.path.startsWith('remove-incluster-mongodb'));
  assert.deepEqual(mongoRemovalPatches.map(patch => patch.path), [
    'remove-incluster-mongodb.yaml',
    'remove-incluster-mongodb-service.yaml',
    'remove-incluster-mongodb-statefulset.yaml',
  ], 'each MongoDB resource must have its own strategic-delete patch document');
  assert.deepEqual(mongoRemovalPatches.map(({ target }) => [target.kind, target.name]), [
    ['PersistentVolumeClaim', 'mongodb-pvc'],
    ['Service', 'wealthgenie-mongodb'],
    ['StatefulSet', 'wealthgenie-mongodb'],
  ]);
  for (const patch of mongoRemovalPatches) {
    const deletion = readYaml(repositoryRoot, `deploy/production/${patch.path}`);
    assert.equal(deletion.$patch, 'delete');
  }
  assert.match(render.run, /kubectl kustomize deploy\/production > build\/production-template\.yaml/);
  assert.match(render.run, /node server\/scripts\/validateProductionImageManifest\.js --template < build\/production-template\.yaml/);
  assert.ok(fs.existsSync(path.join(repositoryRoot, 'k8s/kustomization.yaml')));
  const productionOverlayPaths = spawnSync('git', [
    'ls-files', '--cached', '--others', '--', 'k8s/overlays/production',
  ], { cwd: repositoryRoot, encoding: 'utf8' });
  assert.equal(productionOverlayPaths.status, 0, productionOverlayPaths.stderr);
  assert.equal(productionOverlayPaths.stdout.trim(), '', 'production overlay source files must remain outside the deployable k8s base');
});

test('deployment validator rejects a production overlay that replaces a digest marker with a mutable tag', () => {
  withDeploymentFixture(root => {
    const file = 'deploy/production/kustomization.yaml';
    const overlay = readYaml(root, file);
    overlay.images[0].newTag = 'latest';
    delete overlay.images[0].digest;
    writeYaml(root, file, overlay);

    const result = validate(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /digest-required fail-closed marker/);
  });
});

test('deployment validator rejects a production overlay missing the cache image marker', () => {
  withDeploymentFixture(root => {
    const file = 'deploy/production/kustomization.yaml';
    const overlay = readYaml(root, file);
    overlay.images = overlay.images.filter(image => image.name !== 'redis');
    writeYaml(root, file, overlay);

    const result = validate(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /every application image with an explicit digest-required fail-closed marker/);
  });
});

test('local Compose databases bind published ports to loopback only', () => {
  const compose = readYaml(repositoryRoot, 'docker-compose.yml');
  assert.ok(compose.services.mongodb.ports.includes('127.0.0.1:27017:27017'));
  assert.ok(compose.services.redis.ports.includes('127.0.0.1:6379:6379'));
  assert.equal(compose.services.mongodb.ports.includes('27017:27017'), false);
  assert.equal(compose.services.redis.ports.includes('6379:6379'), false);
});

test('deployment validator requires the agent-worker to use its explicit non-root image UID', () => {
  withDeploymentFixture(root => {
    const workerPath = 'k8s/agent-worker/deployment.yaml';
    const worker = readYaml(root, workerPath);
    delete worker.spec.template.spec.securityContext.runAsUser;
    writeYaml(root, workerPath, worker);

    const result = validate(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /agent-worker must explicitly run as non-root UID 1000/);
  });
});

test('Kubernetes Redis is authenticated and ingress-restricted to its application clients', () => {
  const redis = readYaml(repositoryRoot, 'k8s/redis/deployment.yaml');
  const redisContainer = redis.spec.template.spec.containers[0];
  assert.deepEqual(redisContainer.args, ['--requirepass', '$(REDIS_PASSWORD)']);
  assert.ok(redisContainer.env.some(item => item.name === 'REDIS_PASSWORD'
    && item.valueFrom?.secretKeyRef?.key === 'REDIS_PASSWORD'));
  assert.ok(redisContainer.env.some(item => item.name === 'REDISCLI_AUTH'
    && item.valueFrom?.secretKeyRef?.key === 'REDIS_PASSWORD'));

  const policy = readYaml(repositoryRoot, 'k8s/redis/network-policy.yaml');
  assert.deepEqual(policy.spec.podSelector.matchLabels, { app: 'wealthgenie-redis' });
  const peerApps = policy.spec.ingress.flatMap(rule => rule.from || [])
    .map(peer => peer.podSelector?.matchLabels?.app).sort();
  assert.deepEqual(peerApps, ['wealthgenie-agent-worker', 'wealthgenie-server']);
  for (const secretReference of [
    redisContainer.env.find(item => item.name === 'REDIS_PASSWORD').valueFrom.secretKeyRef,
    redisContainer.env.find(item => item.name === 'REDISCLI_AUTH').valueFrom.secretKeyRef,
  ]) {
    assert.deepEqual(secretReference, { name: 'wealthgenie-secrets', key: 'REDIS_PASSWORD' });
  }

  const result = validate(repositoryRoot);
  assert.equal(result.status, 0, result.stderr);
});

test('deployment validator rejects a Redis deployment without password authentication', () => {
  withDeploymentFixture(root => {
    const redisPath = 'k8s/redis/deployment.yaml';
    const redis = readYaml(root, redisPath);
    redis.spec.template.spec.containers[0].args = [];
    writeYaml(root, redisPath, redis);

    const result = validate(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Redis must require the shared secret password/);
  });
});

test('deployment validator rejects a Redis NetworkPolicy that allows cross-namespace peers', () => {
  withDeploymentFixture(root => {
    const policyPath = 'k8s/redis/network-policy.yaml';
    const policy = readYaml(root, policyPath);
    policy.spec.ingress[0].from[0].namespaceSelector = { matchLabels: { 'kubernetes.io/metadata.name': 'default' } };
    writeYaml(root, policyPath, policy);

    const result = validate(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Redis ingress must be limited to server and agent-worker pods/);
  });
});

test('deployment validator rejects an unrestricted extra Redis ingress rule', () => {
  withDeploymentFixture(root => {
    const policyPath = 'k8s/redis/network-policy.yaml';
    const policy = readYaml(root, policyPath);
    policy.spec.ingress.push({ ports: [{ protocol: 'TCP', port: 6379 }] });
    writeYaml(root, policyPath, policy);

    const result = validate(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Redis ingress must be limited to server and agent-worker pods/);
  });
});

test('deployment validator requires the exact shared Secret for Redis authentication', () => {
  for (const envName of ['REDIS_PASSWORD', 'REDISCLI_AUTH']) {
    withDeploymentFixture(root => {
      const redisPath = 'k8s/redis/deployment.yaml';
      const redis = readYaml(root, redisPath);
      redis.spec.template.spec.containers[0].env.find(item => item.name === envName)
        .valueFrom.secretKeyRef.name = 'unrelated-secret';
      writeYaml(root, redisPath, redis);

      const result = validate(root);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Redis must require the shared secret password/);
    });
  }
  for (const deploymentName of ['wealthgenie-server', 'wealthgenie-agent-worker']) {
    withDeploymentFixture(root => {
      const deploymentPath = deploymentName === 'wealthgenie-server'
        ? 'k8s/server/deployment.yaml'
        : 'k8s/agent-worker/deployment.yaml';
      const deployment = readYaml(root, deploymentPath);
      deployment.spec.template.spec.containers[0].env.find(item => item.name === 'REDIS_PASSWORD')
        .valueFrom.secretKeyRef.name = 'unrelated-secret';
      writeYaml(root, deploymentPath, deployment);

      const result = validate(root);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, new RegExp(`Kubernetes ${deploymentName} must receive the Redis password`));
    });
  }
});

test('deployment validator requires CD worker readiness and transaction/Redis verification', () => {
  withDeploymentFixture(root => {
    const workflowPath = '.github/workflows/cd.yml';
    const workflow = readYaml(root, workflowPath);
    const readiness = workflow.jobs['deploy-and-verify-kind'].steps
      .find(step => step.name === 'Wait for Microservices to be Ready');
    readiness.run = readiness.run.replace('deployment/wealthgenie-agent-worker', 'deployment/wealthgenie-missing-worker');
    writeYaml(root, workflowPath, workflow);

    const result = validate(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ordered one-shot database migrations before applying application workloads/);
  });

  withDeploymentFixture(root => {
    const workflowPath = '.github/workflows/cd.yml';
    const workflow = readYaml(root, workflowPath);
    const smoke = workflow.jobs['deploy-and-verify-kind'].steps
      .find(step => step.name === 'Execute Live Smoke Tests & Prove Request Flow (Step 2)');
    smoke.run = smoke.run.replace('/health/verification', '/health/deep');
    writeYaml(root, workflowPath, workflow);

    const result = validate(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ordered one-shot database migrations before applying application workloads/);
  });
});

test('deployment validator rejects CD application before the Phase 3 migration', () => {
  withDeploymentFixture(root => {
    const workflowPath = '.github/workflows/cd.yml';
    const workflow = readYaml(root, workflowPath);
    workflow.jobs['deploy-and-verify-kind'].steps = workflow.jobs['deploy-and-verify-kind'].steps
      .filter(step => step.name !== 'Run the one-shot Phase 3 ML/RAG state migration');
    writeYaml(root, workflowPath, workflow);

    const result = validate(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Phase 3 ML\/RAG state migration/);
  });
});

test('deployment validator rejects an unsafe Phase 3 migration Job command', () => {
  withDeploymentFixture(root => {
    const jobPath = 'k8s/phase3-state-migration/job.yaml';
    const job = readYaml(root, jobPath);
    job.spec.template.spec.containers[0].command = ['python', 'scripts/other.py'];
    writeYaml(root, jobPath, job);

    const result = validate(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Phase 3 migration Job must run the explicit migration/);
  });
});

test('deployment validator rejects a Phase 3 migration Job in ordinary kustomize resources', () => {
  withDeploymentFixture(root => {
    const kustomizationPath = 'k8s/kustomization.yaml';
    const kustomization = readYaml(root, kustomizationPath);
    kustomization.resources.push('phase3-state-migration/job.yaml');
    writeYaml(root, kustomizationPath, kustomization);

    const result = validate(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /One-shot database migration Jobs/);
  });
});

test('deployment validator rejects Browser application startup before Phase 3 migration', () => {
  withDeploymentFixture(root => {
    const workflowPath = '.github/workflows/ci.yml';
    const workflow = readYaml(root, workflowPath);
    const steps = workflow.jobs['integration-security'].steps;
    const migrationIndex = steps.findIndex(step => step.name === 'Migrate Phase 3 ML/RAG shared-state indexes');
    const [migration] = steps.splice(migrationIndex, 1);
    const startIndex = steps.findIndex(step => step.name === 'Start real application services');
    steps.splice(startIndex, 0, migration);
    writeYaml(root, workflowPath, workflow);

    const result = validate(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Browser CI must run all ordered database migrations/);
  });
});

test('deployment validator rejects Browser application startup before Phase 5 runtime migration', () => {
  withDeploymentFixture(root => {
    const workflowPath = '.github/workflows/ci.yml';
    const workflow = readYaml(root, workflowPath);
    const steps = workflow.jobs['integration-security'].steps;
    const [migration] = steps.splice(steps.findIndex(step => step.name === 'Migrate Phase 5 durable agent runtime persistence'), 1);
    steps.splice(steps.findIndex(step => step.name === 'Start real application services'), 0, migration);
    writeYaml(root, workflowPath, workflow);

    const result = validate(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Browser CI must run all ordered database migrations/);
  });
});

test('deployment validator rejects production edge startup before persistence migration and RAG bootstrap', () => {
  withDeploymentFixture(root => {
    const workflowPath = '.github/workflows/ci.yml';
    const workflow = readYaml(root, workflowPath);
    const steps = workflow.jobs['integration-security'].steps;
    const startIndex = steps.findIndex(step => step.name === 'Start the real Nginx edge stack');
    const [phase2Migration] = steps.splice(steps.findIndex(step => step.name === 'Run the explicit Phase 2 persistence migration'), 1);
    steps.splice(startIndex, 0, phase2Migration);
    writeYaml(root, workflowPath, workflow);

    const result = validate(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Production edge E2E must run the ordered persistence migrations and production RAG\/model bootstrap/);
  });
});

test('deployment validator rejects Kind application rollout before Phase 5 runtime migration', () => {
  withDeploymentFixture(root => {
    const workflowPath = '.github/workflows/cd.yml';
    const workflow = readYaml(root, workflowPath);
    const steps = workflow.jobs['deploy-and-verify-kind'].steps;
    const [migration] = steps.splice(steps.findIndex(step => step.name === 'Run the one-shot Phase 5 durable agent runtime migration'), 1);
    const applyIndex = steps.findIndex(step => step.name === 'Apply application manifests after database migrations');
    steps.splice(applyIndex + 1, 0, migration);
    writeYaml(root, workflowPath, workflow);

    const result = validate(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Kind CD must wait for all ordered one-shot database migrations/);
  });
});

test('managed production Redis target is secret-sourced by both API and worker', () => {
  for (const file of ['deploy/production/server-patch.yaml', 'deploy/production/worker-patch.yaml']) {
    const patch = readYaml(repositoryRoot, file);
    const redis = patch.spec.template.spec.containers[0].env.find(x => x.name === 'REDIS_URL');
    assert.deepEqual(redis.valueFrom.secretKeyRef, { name: 'wealthgenie-secrets', key: 'REDIS_URL' });
    assert.equal(Object.hasOwn(redis, 'value'), false);
  }
  withDeploymentFixture(root => {
    const path = 'deploy/production/worker-patch.yaml';
    const patch = readYaml(root, path);
    patch.spec.template.spec.containers[0].env.find(x => x.name === 'REDIS_URL').valueFrom.secretKeyRef.key = 'INVALID_REDIS_KEY';
    writeYaml(root, path, patch);
    const result = validate(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /same required Redis URL Secret/);
  });
});
