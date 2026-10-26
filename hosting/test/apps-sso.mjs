#!/usr/bin/env node
/**
 * Browser check of single sign-on into the four product apps:
 *   node apps-sso.mjs --password <p> --playwright-from <dir with @playwright/test> [--only retail-os,library]
 * For each app: open its sign-in page, take "Sign in with SSO", sign in at the identity provider, expect to land
 * inside the app (not back on its sign-in page). Also checks that an identity with no account there is refused.
 */
import path from 'node:path';
import { createRequire } from 'node:module';

const args = process.argv.slice(2);
const arg = (n) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const password = arg('password');
const from = arg('playwright-from');
const only = arg('only')?.split(',');
if (!password || !from) {
  console.error('Usage: apps-sso.mjs --password <p> --playwright-from <dir> [--only a,b]');
  process.exit(2);
}
const { chromium } = createRequire(path.join(from, 'package.json'))('@playwright/test');

const APPS = {
  'retail-os': { origin: 'https://saas-retail.vercel.app', email: 'shop.manager@examplecorp.com', refused: 'approver@edams.local' },
  jobpilot: { origin: 'https://saas-jobpilot.vercel.app', email: 'jobseeker.ana@examplecorp.com', refused: 'approver@edams.local' },
  martronics: { origin: 'https://saas-martronics.vercel.app', email: 'shop.manager@examplecorp.com', refused: 'approver@edams.local' },
  library: { origin: 'https://saas-library.vercel.app', email: 'librarian.lia@examplecorp.com', refused: 'approver@edams.local' },
};

let failed = 0;
const check = (ok, what) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failed += 1;
};

async function attempt(app, email) {
  const browser = await chromium.launch();
  const page = await (await browser.newContext()).newPage();
  try {
    await page.goto(`${app.origin}/login`, { waitUntil: 'domcontentloaded' });
    const link = page.getByRole('link', { name: /sign in with sso/i });
    await link.first().waitFor({ timeout: 30000 });
    await link.first().click();
    await page.waitForURL(/\/sso\//, { timeout: 60000 });
    await page.fill('#email', email, { timeout: 20000 });
    await page.fill('#password', password);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.waitForURL((u) => u.href.startsWith(app.origin), { timeout: 90000 });
    await page.waitForLoadState('domcontentloaded');
    return { url: page.url(), page, browser };
  } catch (error) {
    return { url: `error: ${error.message.split('\n')[0]} at ${page.url()}`, page, browser };
  }
}

for (const [key, app] of Object.entries(APPS)) {
  if (only && !only.includes(key)) continue;
  console.log(`\n${key}`);
  const ok = await attempt(app, app.email);
  check(ok.url.startsWith(app.origin) && !/\/login/.test(new URL(ok.url.startsWith('http') ? ok.url : app.origin).pathname), `${app.email} lands inside the app (${ok.url})`);
  await ok.browser.close();
  const no = await attempt(app, app.refused);
  check(/error=no-account/.test(no.url), `${app.refused} has no account and is refused (${no.url})`);
  await no.browser.close();
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
