#!/usr/bin/env node
/**
 * Acceptance test for the hosted SaaS editions, run in a real browser against the PUBLIC address:
 * sign in once at the identity provider, then open the document system and the guest system from
 * the portal without signing in again. It proves the whole chain: the public address, the
 * rewrites or tunnel, the three backends, the OIDC redirects and the cookies.
 *
 *   node saas-flow.mjs --origin https://portal.example.com --password <admin password>
 *                      --playwright-from <a folder whose node_modules has @playwright/test>
 *                      [--email admin@examplecorp.com] [--shots <dir>]
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}
const origin = (arg('origin') ?? '').replace(/\/+$/, '');
const password = arg('password');
const from = arg('playwright-from');
const email = arg('email', 'admin@examplecorp.com');
const shots = arg('shots');
if (!origin || !password || !from) {
  console.error('Usage: saas-flow.mjs --origin <https://host> --password <pw> --playwright-from <dir> [--email e] [--shots dir]');
  process.exit(2);
}
const { chromium } = createRequire(path.join(from, 'package.json'))('@playwright/test');
if (shots) fs.mkdirSync(shots, { recursive: true });

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok || !detail ? '' : `  -> ${detail}`}`);
};
const snap = async (page, name) => {
  if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true });
};

/**
 * Follow a portal link the way a person does. The hand-off pages redirect and auto-submit, so a
 * navigation is "done" only when the browser has settled on the target system's own path.
 */
async function open(href, prefix) {
  const target = href.startsWith('http') ? href : `${origin}${href}`;
  await page.goto(target, { waitUntil: 'commit', timeout: 90_000 }).catch(() => undefined);
  await page.waitForURL((u) => u.pathname.startsWith(prefix) && !u.pathname.includes('__sso'), { timeout: 90_000 });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(2000);
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const problems = [];
page.on('pageerror', (e) => problems.push(String(e)));
page.on('response', (r) => {
  if (r.status() >= 500) problems.push(`${r.status()} ${r.url()}`);
});

try {
  // 1. sign in at the identity provider
  await page.goto(`${origin}/sso/portal`, { waitUntil: 'networkidle', timeout: 90_000 });
  check('the portal sends a visitor to the sign-in page', page.url().includes('/sso/interaction/'), page.url());
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.waitForURL(`${origin}/sso/portal**`, { timeout: 60_000 });
  await page.waitForLoadState('networkidle');
  await snap(page, '1-portal');
  const body = await page.locator('body').innerText();
  check('signing in lands on the portal', /portal|applications|documents|guest/i.test(body), body.slice(0, 120));

  // 2. open the document system from the portal
  const links = await page.locator('a').evaluateAll((as) => as.map((a) => [a.textContent?.trim() ?? '', a.getAttribute('href') ?? '']));
  const dms = links.find(([t, h]) => /\/dms/.test(h) || /document|dms|edams/i.test(t));
  const gms = links.find(([t, h]) => /\/gms|bridge\/gms/.test(h) || /guest|visitor|gms/i.test(t));
  check('the portal offers the document system', Boolean(dms), JSON.stringify(links.slice(0, 8)));
  check('the portal offers the guest system', Boolean(gms), JSON.stringify(links.slice(0, 8)));

  if (dms) {
    await open(dms[1], '/dms');
    await snap(page, '2-dms');
    const u = new URL(page.url());
    check('the document system opens without a second sign-in', u.pathname.startsWith('/dms') && !/login/.test(u.pathname), page.url());
    const text = await page.locator('body').innerText();
    check('the document system shows its dashboard, not an error', text.length > 50 && !/internal server error|application error/i.test(text), text.slice(0, 160));
  }

  if (gms) {
    await open(gms[1], '/gms');
    await snap(page, '3-gms');
    const u = new URL(page.url());
    check('the guest system opens without a second sign-in', u.pathname.startsWith('/gms') && !/login/.test(u.pathname), page.url());
    const text = await page.locator('body').innerText();
    check('the guest system shows its dashboard, not an error', text.length > 50 && !/internal server error|application error/i.test(text), text.slice(0, 160));
  }
  check('no server error or script error on the way', problems.length === 0, problems.slice(0, 4).join(' | '));
} catch (e) {
  failures += 1;
  console.log(` FAIL  the flow stopped: ${e.message.split('\n')[0]}`);
  await snap(page, 'failure').catch(() => undefined);
} finally {
  await browser.close();
}
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
