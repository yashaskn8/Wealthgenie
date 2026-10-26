import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

for (const [service, deploymentPath, dockerPath, dockerUser] of [
  ['API', 'k8s/server/deployment.yaml', 'server/Dockerfile', 'node'],
  ['ML', 'k8s/ml-service/deployment.yaml', 'ml-service/Dockerfile', 'appuser'],
]) {
  test(`${service} runs non-root, without privilege escalation or extra capabilities`, () => {
    const yaml = fs.readFileSync(path.join(root, deploymentPath), 'utf8');
    const parsed = parseDocument(yaml, { uniqueKeys: true, strict: true });
    assert.deepEqual(parsed.errors.map(error => error.message), []);
    const deployment = parsed.toJS();
    const pod = deployment.spec.template.spec;
    assert.equal(pod.securityContext.runAsNonRoot, true);
    assert.equal(pod.securityContext.runAsUser, 1000);
    assert.equal(pod.securityContext.seccompProfile.type, 'RuntimeDefault');
    assert.equal(pod.containers.length, 1);
    const security = pod.containers[0].securityContext;
    assert.equal(security.allowPrivilegeEscalation, false);
    assert.deepEqual(security.capabilities.drop, ['ALL']);
    const dockerfile = fs.readFileSync(path.join(root, dockerPath), 'utf8');
    assert.ok(dockerfile.includes('USER ' + dockerUser),
      'image and manifest must agree on non-root identity');
  });
}
