#!/usr/bin/env node
/**
 * Deploys the web apps of the four product repositories (Retail OS, JobPilot, Martronics, Library) to Vercel, one
 * project each, with this machine hosting their APIs and databases.
 *
 *   VERCEL_TOKEN=... node deploy-apps.mjs --apps-root <dir> --backend-origin https://host.ts.net [--prefix saas] [--only a,b] [--team id]
 *
 * Each project builds apps/web of its repository (a pnpm workspace, so the whole repository is uploaded and
 * the install runs at its root). The web app talks to its API through the backend origin:
 *   API_URL    = <backend origin>/app-api/<app>      (nginx on this machine routes that path to the app's API)
 *   APP_ORIGIN = the project's own public address    (the single sign-on callback is built from it)
 * Prints the addresses; hosting/scripts/apps.mjs registers them as single sign-on clients.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}
const token = process.env.VERCEL_TOKEN;
const appsRoot = arg('apps-root');
const backendOrigin = (arg('backend-origin') ?? '').replace(/\/+$/, '');
const prefix = arg('prefix', 'saas');
const team = arg('team');
const only = arg('only')?.split(',');
if (!token || !appsRoot || !/^https:\/\/[a-z0-9.-]+$/i.test(backendOrigin)) {
  console.error('Usage: VERCEL_TOKEN=... node deploy-apps.mjs --apps-root <dir> --backend-origin <https://host> [--prefix saas] [--only a,b] [--team id]');
  process.exit(2);
}

export const APPS = {
  'retail-os': { dir: 'retail-os', project: `${prefix}-retail` },
  jobpilot: { dir: 'jobpilot', project: `${prefix}-jobpilot` },
  martronics: { dir: 'martronics', project: `${prefix}-martronics` },
  library: { dir: 'library-management-system', project: `${prefix}-library` },
};

const API = 'https://api.vercel.com';
const q = team ? `?teamId=${encodeURIComponent(team)}` : '';
const qAnd = team ? `&teamId=${encodeURIComponent(team)}` : '';

async function api(method, route, body) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const res = await fetch(`${API}${route}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      const json = text ? JSON.parse(text) : {};
      if (!res.ok && !(method === 'POST' && res.status === 409)) throw new Error(`${method} ${route} failed: ${res.status} ${json?.error?.message ?? text.slice(0, 200)}`);
      return { ...json, __status: res.status };
    } catch (e) {
      if (attempt >= 4 || !/fetch failed|timeout/i.test(String(e.cause ?? e))) throw e;
      await new Promise((r) => setTimeout(r, 4000));
    }
  }
}

async function ensureProject(name, settings) {
  // The create endpoint refuses sourceFilesOutsideRootDirectory; the update endpoint takes it.
  const { sourceFilesOutsideRootDirectory, ...createSettings } = settings;
  const created = await api('POST', `/v11/projects${q}`, { name, ...createSettings });
  const project = created.__status === 409 ? await api('GET', `/v9/projects/${encodeURIComponent(name)}${q}`) : created;
  await api('PATCH', `/v9/projects/${project.id}${q}`, { ...createSettings, sourceFilesOutsideRootDirectory });
  return project;
}

async function address(project) {
  const fresh = await api('GET', `/v9/projects/${project.id}${q}`);
  const aliases = (fresh.targets?.production?.alias ?? fresh.alias?.map?.((a) => a.domain ?? a) ?? []).filter((a) => a.endsWith('.vercel.app'));
  aliases.sort((a, b) => a.length - b.length);
  return `https://${aliases[0] ?? `${project.name}.vercel.app`}`;
}

const setEnv = (project, vars) =>
  api(
    'POST',
    `/v10/projects/${project.id}/env?upsert=true${qAnd}`,
    Object.entries(vars).map(([key, value]) => ({ key, value, type: 'plain', target: ['production', 'preview'] })),
  );

function deploy(cwd, project) {
  const ignoreFile = path.join(cwd, '.vercelignore');
  const previous = fs.existsSync(ignoreFile) ? fs.readFileSync(ignoreFile, 'utf8') : null;
  fs.writeFileSync(ignoreFile, `${previous ?? ''}\n.env\n.env.*\n**/.env\n**/.env.*\nnode_modules\n**/node_modules\n.next\n**/.next\n.turbo\n**/.turbo\ndist\n**/dist\n.git\nlogs\n`);
  try {
    const r = spawnSync('vercel', ['deploy', '--prod', '--yes', '--token', token, ...(team ? ['--scope', team] : [])], {
      cwd,
      env: { ...process.env, VERCEL_ORG_ID: project.accountId, VERCEL_PROJECT_ID: project.id },
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    if (r.status !== 0) throw new Error(`vercel deploy failed for ${project.name} (exit ${r.status})`);
  } finally {
    if (previous === null) fs.rmSync(ignoreFile, { force: true });
    else fs.writeFileSync(ignoreFile, previous);
  }
}

const result = {};
for (const [key, app] of Object.entries(APPS)) {
  if (only && !only.includes(key)) continue;
  console.log(`\n== ${key}`);
  const project = await ensureProject(app.project, {
    framework: 'nextjs',
    rootDirectory: 'apps/web',
    installCommand: 'cd ../.. && corepack pnpm install --frozen-lockfile',
    buildCommand: 'corepack pnpm exec next build',
    sourceFilesOutsideRootDirectory: true,
  });
  const origin = await address(project);
  await setEnv(project, {
    ENABLE_EXPERIMENTAL_COREPACK: '1',
    API_URL: `${backendOrigin}/app-api/${key}`,
    APP_ORIGIN: origin,
  });
  deploy(path.join(appsRoot, app.dir), project);
  result[key] = await address(project);
  console.log(`  ${key}: ${result[key]}`);
}
console.log('\n' + JSON.stringify(result, null, 2));
