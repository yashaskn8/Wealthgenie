/**
 * WealthGenie architecture contract checker.
 *
 * Verify authority boundaries directly in implementation and regression
 * coverage so the check does not depend on optional overview documentation.
 */
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const files = {
  chat: path.join(ROOT_DIR, 'server', 'services', 'geminiChatService.js'),
  explanation: path.join(ROOT_DIR, 'server', 'services', 'groundedExplanationService.js'),
  validator: path.join(ROOT_DIR, 'server', 'services', 'groundingValidator.js'),
  providers: path.join(ROOT_DIR, 'server', 'services', 'providerAbstraction.js'),
  marketContextPolicy: path.join(ROOT_DIR, 'server', 'services', 'marketContextPolicy.js'),
  regimeRotationTest: path.join(ROOT_DIR, 'server', 'test', 'regimeRotationEngine.test.js'),
  mongoExample: path.join(ROOT_DIR, '.env.example'),
  mlMain: path.join(ROOT_DIR, 'ml-service', 'main.py'),
  mlSecurity: path.join(ROOT_DIR, 'ml-service', 'security.py'),
};

console.log('='.repeat(70));
console.log('WealthGenie Architecture Contract Checker');
console.log('='.repeat(70));

let failures = 0;

function assertFileExists(filePath, name) {
  if (!fs.existsSync(filePath)) {
    console.error(`[FAIL] Required file missing: ${name} (${filePath})`);
    failures += 1;
    return false;
  }
  console.log(`[PASS] Found ${name}`);
  return true;
}

function assertMatches(filePath, pattern, description) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf8');
  if (!pattern.test(content)) {
    console.error(`[FAIL] Architecture mismatch: ${description} in ${path.basename(filePath)}`);
    failures += 1;
  } else {
    console.log(`[PASS] Verified ${description}`);
  }
}

function assertDoesNotMatch(filePath, pattern, description) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf8');
  if (pattern.test(content)) {
    console.error(`[FAIL] Retired architecture remains: ${description} in ${path.basename(filePath)}`);
    failures += 1;
  } else {
    console.log(`[PASS] Verified absence of ${description}`);
  }
}

for (const [name, filePath] of Object.entries(files)) assertFileExists(filePath, name);

assertMatches(files.chat, /buildChatEvidencePacket[\s\S]*generateGroundedExplanation/, 'chat builds evidence then requests a grounded explanation');
assertDoesNotMatch(files.chat, /queryRAG|ragClient|intentGate|aiToolOrchestrator/, 'retired RAG/tool-routing financial authority');
assertMatches(files.explanation, /GROUNDED_LLM_TOOL_ALLOWLIST\s*=\s*Object\.freeze\(\[\]\)/, 'LLM tool allowlist is empty');
assertMatches(files.explanation, /validateGroundedExplanation/, 'LLM output is validated against its evidence packet');
assertMatches(files.explanation, /DETERMINISTIC_TEMPLATE/, 'validated deterministic explanation fallback remains available');
assertMatches(files.providers, /NvidiaNimProviderAdapter/, 'NVIDIA NIM adapter exists behind the provider abstraction');
assertMatches(files.mlSecurity, /env_mode\s+not\s+in\s+LOCAL_ENVIRONMENTS/, 'ML service authentication fails closed outside local environments');
assertMatches(files.marketContextPolicy, /MARKET_CONTEXT_POLICY_VERSION\s*=\s*'market-context-policy-\d+\.\d+\.\d+'/, 'deterministic market-context policy is explicitly versioned');
assertMatches(files.regimeRotationTest, /an ML shadow state cannot become an allocation context/i, 'ML shadow state remains outside allocation contexts under regression coverage');
assertMatches(files.mongoExample, /MONGODB_URI=.*replicaSet=rs0/i, 'local Mongo configuration uses a transaction-capable replica set');

console.log('='.repeat(70));
if (failures > 0) {
  console.error(`FAILED: ${failures} architecture sync checks failed.`);
  process.exit(1);
}
console.log('SUCCESS: implementation authority contracts match their regression coverage.');
