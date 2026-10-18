import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// An ordinary Vite document response cannot prove React actually rendered.
// This no-mutation smoke verifies the two unauthenticated presentation screens.
export function parseDemoOrigin(raw) {
  if (typeof raw !== 'string' || raw.length > 180) throw new TypeError('DEMO_ORIGIN_INVALID');
  let url;
  try { url = new URL(raw); } catch { throw new TypeError('DEMO_ORIGIN_INVALID'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)
      || !url.port || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new TypeError('DEMO_ORIGIN_INVALID');
  }
  return url.origin;
}

export async function runDemoBrowserSmoke({ origin, launchBrowser, timeoutMs = 15000 } = {}) {
  const trustedOrigin = parseDemoOrigin(origin);
  // Use the existing React installation. Never install or download tools.
  const launch = launchBrowser || (async () => {
    const fromReactapp = createRequire(new URL('../reactapp/package.json', import.meta.url));
    const { chromium } = fromReactapp('@playwright/test');
    return chromium.launch({ headless: true });
  });
  let browser;
  try {
    browser = await launch();
    const page = await browser.newPage();
    const runtimeErrors = [];
    page.on('pageerror', error => runtimeErrors.push(String(error?.name || 'BrowserScriptError').slice(0, 60)));
    await page.route('**/*', route => {
      let resource;
      try { resource = new URL(route.request().url()); } catch { return route.abort(); }
      // No off-origin fonts, tracking, links, services or API traffic.
      return resource.origin === trustedOrigin ? route.continue() : route.abort();
    });
    const login = await page.goto(trustedOrigin + '/login', { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    if (login?.status() !== 200) throw new Error('DEMO_LOGIN_HTTP_FAILURE');
    await page.locator('#login-view #login-email').waitFor({ state: 'visible', timeout: timeoutMs });
    await page.locator('#login-form button[type="submit"]').waitFor({ state: 'visible', timeout: timeoutMs });
    await page.locator('#login-view a').waitFor({ state: 'visible', timeout: timeoutMs });
    if (runtimeErrors.length) throw new Error('DEMO_LOGIN_SCRIPT_FAILURE');
    const landing = await page.goto(trustedOrigin + '/', { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    if (landing?.status() !== 200) throw new Error('DEMO_LANDING_HTTP_FAILURE');
    await page.getByRole('link', { name: 'Summon Genie' }).waitFor({ state: 'visible', timeout: timeoutMs });
    if (runtimeErrors.length) throw new Error('DEMO_LANDING_SCRIPT_FAILURE');
    return {
      status: 'PASS',
      verified: ['login-rendered', 'register-link-rendered', 'landing-cta-rendered'],
      authenticated: false,
    };
  } finally {
    await browser?.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runDemoBrowserSmoke({ origin: process.argv[2] });
    process.stdout.write('DEMO_BROWSER_' + result.status
      + ': login, registration CTA, and landing CTA rendered without account mutations.\n');
  } catch (error) {
    const code = /^DEMO_[A-Z_]+$/.test(error?.message || '') ? error.message : 'DEMO_BROWSER_NOT_VERIFIED';
    process.stderr.write(code
      + ': Browser smoke failed. Inspect Vite/React logs and ensure Playwright Chromium is installed.\n');
    process.exitCode = 1;
  }
}
