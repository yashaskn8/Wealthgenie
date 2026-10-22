import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEnvironmentConfig } from '../config/validateEnv.js';
const errors = env => validateEnvironmentConfig(env).errors;
test('PostgreSQL cannot be enabled with a missing or non-PostgreSQL URI', () => {
  for (const url of [undefined, 'https://example.com', 'postgres://no-database/', 'postgres://']) {
    assert.ok(errors({ NODE_ENV:'test', FINANCIAL_POSTGRES_ENABLED:'true',
      FINANCIAL_POSTGRES_URL:url }).some(e=>e.includes('valid PostgreSQL database URL')));
  }
});
test('production PostgreSQL requires certificate/hostname verifying SSL mode', () => {
  const common = { NODE_ENV:'production', FINANCIAL_POSTGRES_ENABLED:'true' };
  assert.ok(errors({...common, FINANCIAL_POSTGRES_URL:'postgresql://user:pass@pg.example.com/wealthgenie?sslmode=require'})
    .some(e=>e.includes('sslmode=verify-full')));
  assert.ok(!errors({...common, FINANCIAL_POSTGRES_URL:'postgresql://user:pass@pg.example.com/wealthgenie?sslmode=verify-full'})
    .some(e=>e.includes('financial PostgreSQL')));
});
test('disabled PostgreSQL leaves legacy MongoDB-only workflows alone', () => {
  assert.ok(!errors({NODE_ENV:'test', FINANCIAL_POSTGRES_ENABLED:'false'})
    .some(e=>e.includes('financial PostgreSQL')));
});


test('private financial architecture cannot be turned on before PostgreSQL activation', () => {
  const invalid=errors({NODE_ENV:'test',FINANCIAL_ARCHITECTURE_ENABLED:'true',
    FINANCIAL_POSTGRES_ENABLED:'false'});
  assert.ok(invalid.some(e=>e.includes('requires FINANCIAL_POSTGRES_ENABLED=true')));
  const valid=errors({NODE_ENV:'test',FINANCIAL_ARCHITECTURE_ENABLED:'true',
    FINANCIAL_POSTGRES_ENABLED:'true',
    FINANCIAL_POSTGRES_URL:'postgresql://test:test@localhost/financial_test'});
  assert.ok(!valid.some(e=>e.includes('FINANCIAL_ARCHITECTURE_ENABLED')));
});
