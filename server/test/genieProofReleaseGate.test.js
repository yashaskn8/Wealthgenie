import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const cd = readFileSync(new URL('../../.github/workflows/cd.yml', import.meta.url),'utf8');
const proof = readFileSync(new URL('../../.github/workflows/genieproof-quality.yml', import.meta.url),'utf8');
const ci = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url),'utf8');

test('deployment requires every exact-main quality result, including GenieProof', () => {
  assert.match(cd,/for workflow in ci\.yml genievoice-quality\.yml coverage-firewall-ci\.yml genieproof-quality\.yml; do/);
  assert.match(cd,/-f head_sha="\$VERIFIED_SHA" -f event=push/);
  assert.match(cd,/if \[ "\$VERIFIED_SHA" != "\$latest_sha" \]; then/);
  assert.match(cd,/SOURCE_CI_SUCCESS/);
  assert.match(cd,/case "\$conclusion" in[\s\S]*success\) ;;[\s\S]*pending\)[\s\S]*exit 1/);
  assert.match(cd,/needs: release-quality-gate/);
  assert.match(cd,/needs\.release-quality-gate\.outputs\.ready == 'true'/);
});

test('GenieProof safety must run on ALL main pushes, not only GenieProof file changes', () => {
  assert.match(proof,/push:\s*\n\s*branches: \[main\]/);
  const pushBlock = proof.split(/^  pull_request:/m)[0];
  assert.doesNotMatch(pushBlock,/\n\s*paths:/);
  assert.match(proof,/test\/genieProofArchitectureTournament\.test\.js/);
  assert.match(proof,/test\/genieProofClaimTriage\.test\.js/);
  assert.match(proof,/test\/genieProofCheckService\.test\.js/);
  assert.match(proof,/npm run build/);
  assert.match(proof,/npm run typecheck/);
  assert.match(ci,/Run real-dependency Playwright lifecycle/);
  assert.match(ci,/--grep-invert @production-edge/);
});
