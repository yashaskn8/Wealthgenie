import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDemoOrigin, runDemoBrowserSmoke } from '../../scripts/demoBrowserSmoke.mjs';

test('demo browser probe permits only HTTP localhost origins without any credentials or paths', () => {
  assert.equal(parseDemoOrigin('http://127.0.0.1:5174'), 'http://127.0.0.1:5174');
  assert.equal(parseDemoOrigin('http://localhost:5174/'), 'http://localhost:5174');
  for (const bad of [
    'https://example.com', 'http://example.com:5174', 'http://127.0.0.1:5174/proxy',
    'http://localhost:5174/?token=secret', 'http://bob:abc@127.0.0.1:5174',
    'file:///etc/passwd', 'http://[::1]:5174', 'http://127.0.0.1',
  ]) {
    assert.throws(() => parseDemoOrigin(bad), /DEMO_ORIGIN_INVALID/, bad);
  }
});

function fakeBrowser({ loginStatus = 200, landingStatus = 200, error = null } = {}) {
  const page = {
    on: (name, callback) => {
      if (error && name === 'pageerror') callback({ name: error });
    },
    route: async (_pattern, callback) => {
      const aborts = [];
      callback({
        request: () => ({ url: () => 'https://outside.example/fonts.css' }),
        abort: () => aborts.push(true),
        continue: () => { throw new Error('Cross-origin browser request was allowed'); },
      });
      assert.equal(aborts.length, 1);
    },
    goto: async url => ({ status: () => url.endsWith('/login') ? loginStatus : landingStatus }),
    locator: selector => {
      assert.ok(['#login-view #login-email', '#login-form button[type="submit"]', '#login-view a'].includes(selector));
      return { waitFor: async () => {} };
    },
    getByRole: (role, opts) => {
      assert.deepEqual([role, opts.name], ['link', 'Summon Genie']);
      return { waitFor: async () => {} };
    },
  };
  const state = { closed: false };
  const browser = { newPage: async () => page, close: async () => { state.closed = true; } };
  return { browser, state };
}

test('read-only browser preflight verifies rendered login, registration and landing CTAs', async () => {
  const { browser, state } = fakeBrowser();
  assert.deepEqual(await runDemoBrowserSmoke({
    origin: 'http://127.0.0.1:5174',
    launchBrowser: async () => browser,
  }), {
    status: 'PASS',
    verified: ['login-rendered', 'register-link-rendered', 'landing-cta-rendered'],
    authenticated: false,
  });
  assert.equal(state.closed, true);
});

test('browser preflight refuses HTTP and script failures while always closing the browser', async () => {
  for (const config of [{ loginStatus: 503 }, { landingStatus: 500 }, { error: 'TypeError' }]) {
    const { browser, state } = fakeBrowser(config);
    await assert.rejects(runDemoBrowserSmoke({
      origin: 'http://127.0.0.1:5174',
      launchBrowser: async () => browser,
    }), /DEMO_(?:LOGIN|LANDING)_/);
    assert.equal(state.closed, true);
  }
});
