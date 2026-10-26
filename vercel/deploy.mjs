#!/usr/bin/env node
/**
 * Puts the three SaaS frontends on Vercel and one small "portal" project in front of them, so the
 * whole platform answers at ONE public address with the same paths the company uses (/sso, /dms,
 * /gms). The backends, the databases, Redis and file storage stay on this machine; the portal
 * project forwards /api, /socket.io, /dms/api/v1 and /gms/__sso to them through the tunnel.
 *
 *   VERCEL_TOKEN=... node deploy.mjs --saas-root <dir> --runtime <dir> --backend-origin https://api.example.com
 *                                    [--prefix saas] [--team <team id or slug>] [--origin https://portal.example.com]
 *                                    [--dry-run]
 *
 *  - VERCEL_TOKEN: create one at vercel.com/account/tokens. It is only read from the environment.
 *  - --backend-origin: the public address of the tunnel that reaches this machine's nginx entry
 *    (a named tunnel on your domain, or a trycloudflare.com address for a trial).
 *  - --origin: the public address people will use. Leave it out to use the portal project's own
 *    <prefix>-portal.vercel.app address; pass your domain once you have attached it to the portal project.
 *
 * What it does, in order: creates the four projects (or finds them), decides the public address,
 * writes the frontends' build settings as project environment variables (addresses only, no
 * secrets), deploys the three frontends, then deploys the portal with the rewrites. It does not
 * touch the backends: run hosting/scripts/prepare.mjs with the SAME --origin and --backend-origin
 * first (the identity provider must be told the public address), and stack.mjs up after.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}
const dryRun = process.argv.includes('--dry-run');
const onlyAddress = process.argv.includes('--only-address');
const token = process.env.VERCEL_TOKEN;
const saasRoot = arg('saas-root');
const runtime = arg('runtime');
const prefix = arg('prefix', 'saas');
const team = arg('team');
const backendOrigin = (arg('backend-origin') ?? '').replace(/\/+$/, '');
let origin = (arg('origin') ?? '').replace(/\/+$/, '');
if (!saasRoot || !runtime || (!backendOrigin && !onlyAddress) || (!token && !dryRun)) {
  console.error('Usage: VERCEL_TOKEN=... node deploy.mjs --saas-root <dir> --runtime <dir> --backend-origin <https://host> [--prefix saas] [--team id] [--origin https://host] [--dry-run] [--only-address]');
  process.exit(2);
}
if (backendOrigin && !/^https:\/\/[a-z0-9.-]+$/i.test(backendOrigin)) {
  console.error(`--backend-origin must be an https origin without a path, got "${backendOrigin}"`);
  process.exit(2);
}

const API = 'https://api.vercel.com';
const q = team ? `?teamId=${encodeURIComponent(team)}` : '';
const qAnd = team ? `&teamId=${encodeURIComponent(team)}` : '';
const root = (...p) => path.join(saasRoot, ...p);
const names = { portal: `${prefix}-portal`, sso: `${prefix}-sso`, dms: `${prefix}-dms`, gms: `${prefix}-gms` };

async function api(method, route, body) {
  if (dryRun) {
    console.log(`  [dry run] ${method} ${route}${body ? ' ' + JSON.stringify(body).slice(0, 160) : ''}`);
    return { id: `dry-${route}`, accountId: 'dry-account', name: route, targets: {}, alias: [] };
  }
  const res = await fetch(`${API}${route}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok && !(method === 'POST' && res.status === 409)) {
    throw new Error(`${method} ${route} failed: ${res.status} ${json?.error?.message ?? text.slice(0, 200)}`);
  }
  return { ...json, __status: res.status };
}

/** Create the project, or return the existing one. */
async function ensureProject(name, settings) {
  const created = await api('POST', `/v11/projects${q}`, { name, ...settings });
  if (created.__status === 409) {
    const found = await api('GET', `/v9/projects/${encodeURIComponent(name)}${q}`);
    console.log(`  project ${name}: exists`);
    return found;
  }
  console.log(`  project ${name}: created`);
  return created;
}

const NEXT = { framework: 'nextjs', installCommand: 'npm ci', buildCommand: 'npx next build' };

/** The project's public vercel.app address: its shortest production alias, else the name itself. */
async function publicAddress(project, name) {
  const fresh = await api('GET', `/v9/projects/${project.id}${q}`);
  const aliases = (fresh.targets?.production?.alias ?? fresh.alias?.map?.((a) => a.domain ?? a) ?? []).filter((a) => a.endsWith('.vercel.app'));
  aliases.sort((a, b) => a.length - b.length);
  return `https://${aliases[0] ?? `${name}.vercel.app`}`;
}

/** Read KEY=value lines (no export, no quotes) from an env file. */
function readEnv(file) {
  return Object.fromEntries(
    fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter((l) => /^[A-Z][A-Z0-9_]*=/.test(l))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/\s+#.*$/, '')]),
  );
}

async function setEnv(project, vars) {
  const body = Object.entries(vars).map(([key, value]) => ({
    key,
    value,
    type: 'plain', // addresses only; nothing here is a secret
    target: ['production', 'preview'],
  }));
  await api('POST', `/v10/projects/${project.id}/env?upsert=true${qAnd}`, body);
  console.log(`  ${project.name ?? ''}: ${body.length} environment variables set`);
}

function deploy(cwd, project, label) {
  console.log(`\n== deploying ${label}`);
  if (dryRun) {
    console.log(`  [dry run] vercel deploy --prod in ${cwd}`);
    return;
  }
  // Nothing secret may be uploaded: the env files hold real passwords and are never part of a
  // deployment (the frontends get their settings as project variables). A temporary .vercelignore
  // makes that explicit instead of relying on the repository's .gitignore.
  const ignoreFile = path.join(cwd, '.vercelignore');
  const hadIgnore = fs.existsSync(ignoreFile);
  const previous = hadIgnore ? fs.readFileSync(ignoreFile, 'utf8') : '';
  fs.writeFileSync(ignoreFile, `${previous}
.env
.env.*
**/.env
**/.env.*
node_modules
**/node_modules
.next
**/.next
.next-mirror
.git
logs
**/logs
`);
  let r;
  try {
    r = spawnSync('vercel', ['deploy', '--prod', '--yes', '--token', token, ...(team ? ['--scope', team] : [])], {
      cwd,
      env: { ...process.env, VERCEL_ORG_ID: project.accountId, VERCEL_PROJECT_ID: project.id },
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
  } finally {
    if (hadIgnore) fs.writeFileSync(ignoreFile, previous);
    else fs.rmSync(ignoreFile, { force: true });
  }
  if (r.status !== 0) {
    console.error(`${label}: vercel deploy failed (exit ${r.status}).`);
    process.exit(r.status ?? 1);
  }
}

console.log('Projects');
const portal = await ensureProject(names.portal, { framework: null });
const sso = await ensureProject(names.sso, { ...NEXT, rootDirectory: null });
// GMS's frontend installs a tarball from ../vendor, so (like DMS) it is uploaded from the repository root and built from frontend/.
const gms = await ensureProject(names.gms, { ...NEXT, rootDirectory: 'frontend' });
await api('PATCH', `/v9/projects/${gms.id}${q}`, { rootDirectory: 'frontend', sourceFilesOutsideRootDirectory: true });
// DMS is an npm workspace and its Turbopack root is the repository, so it is uploaded whole and built from frontend/.
const dms = await ensureProject(names.dms, { ...NEXT, rootDirectory: 'frontend', installCommand: 'cd .. && npm ci' });
// The create endpoint refuses this setting; the update endpoint accepts it.
await api('PATCH', `/v9/projects/${dms.id}${q}`, { sourceFilesOutsideRootDirectory: true });

if (onlyAddress) {
  // First run: learn the address Vercel gives the portal before anything is built for it.
  const dir = path.join(runtime, 'vercel-portal-placeholder');
  fs.mkdirSync(path.join(dir, 'public'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'public', 'index.html'),
    '<!doctype html><meta charset="utf-8"><title>Setting up</title><p>This address is being set up.</p>\n',
  );
  deploy(dir, portal, 'a placeholder, to learn the public address');
  console.log(
    `\nPublic address: ${await publicAddress(portal, names.portal)}\nUse it as --origin for prepare.mjs and for this script.`,
  );
  process.exit(0);
}
if (!origin) origin = await publicAddress(portal, names.portal);
console.log(`\nPublic address: ${origin}`);
console.log(`Backend address (the tunnel): ${backendOrigin}`);

// The frontends' addresses are baked into a Next.js build, so they must be right before it runs.
// make-env.mjs already writes them for a given --origin; the same files are the source here.
const sources = {
  sso: root('sso-saas', 'frontend', '.env.production'),
  gms: root('gms-saas', 'frontend', '.env.production'),
  dms: root('dms-saas', 'frontend', '.env.production'),
};
for (const [key, file] of Object.entries(sources)) {
  if (!fs.existsSync(file)) {
    console.error(`${file} is missing. Run hosting/scripts/prepare.mjs --origin ${origin} --backend-origin ${backendOrigin} first.`);
    process.exit(1);
  }
}
const frontendVars = (file) =>
  Object.fromEntries(Object.entries(readEnv(file)).filter(([k]) => k.startsWith('NEXT_PUBLIC_') || k === 'SSO_BACKEND_URL'));
const ssoVars = frontendVars(sources.sso);
if (!dryRun && ssoVars['NEXT_PUBLIC_APP_ORIGIN'] !== origin) {
  console.error(`The SSO frontend env was written for ${ssoVars['NEXT_PUBLIC_APP_ORIGIN']}, not ${origin}. Run prepare.mjs again with --origin ${origin}.`);
  process.exit(1);
}
if (!dryRun && ssoVars['SSO_BACKEND_URL'] !== `${backendOrigin}/sso-backend`) {
  console.error(`The SSO frontend would proxy to ${ssoVars['SSO_BACKEND_URL']}. Run prepare.mjs again with --backend-origin ${backendOrigin}.`);
  process.exit(1);
}
console.log('\nBuild settings');
await setEnv({ ...sso, name: names.sso }, ssoVars);
await setEnv({ ...gms, name: names.gms }, frontendVars(sources.gms));
await setEnv({ ...dms, name: names.dms }, frontendVars(sources.dms));

deploy(root('sso-saas', 'frontend'), sso, 'identity frontend (SSO)');
deploy(root('gms-saas'), gms, 'guest frontend (GMS)');
deploy(root('dms-saas'), dms, 'document frontend (DMS)');

const addresses = {
  sso: await publicAddress(sso, names.sso),
  gms: await publicAddress(gms, names.gms),
  dms: await publicAddress(dms, names.dms),
};
console.log('\nFrontend addresses', addresses);

// ---- the portal: one address, the standard path layout
const t = backendOrigin;
const vercelJson = {
  $schema: 'https://openapi.vercel.sh/vercel.json',
  redirects: [{ source: '/', destination: '/sso/portal', permanent: false }],
  rewrites: [
    // The backends on this machine, through the tunnel (order matters: the specific paths first).
    { source: '/gms/__sso', destination: `${t}/gms/__sso` },
    { source: '/dms/api/v1/:path*', destination: `${t}/dms/api/v1/:path*` },
    { source: '/dms/socket.io/:path*', destination: `${t}/dms/socket.io/:path*` },
    { source: '/api/:path*', destination: `${t}/api/:path*` },
    { source: '/socket.io/:path*', destination: `${t}/socket.io/:path*` },
    // The frontends, each already built for its own base path.
    { source: '/sso/:path*', destination: `${addresses.sso}/sso/:path*` },
    { source: '/dms/:path*', destination: `${addresses.dms}/dms/:path*` },
    { source: '/gms/:path*', destination: `${addresses.gms}/gms/:path*` },
  ],
  headers: [
    {
      source: '/(.*)',
      headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      ],
    },
  ],
};
const portalDir = path.join(runtime, 'vercel-portal');
fs.mkdirSync(path.join(portalDir, 'public'), { recursive: true });
fs.writeFileSync(path.join(portalDir, 'vercel.json'), JSON.stringify(vercelJson, null, 2));
fs.writeFileSync(
  path.join(portalDir, 'public', 'index.html'),
  '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=/sso/portal"><title>Portal</title><a href="/sso/portal">Continue</a>\n',
);
console.log(`\nPortal rewrites written to ${path.join(portalDir, 'vercel.json')}`);
deploy(portalDir, portal, 'the portal (one address for all three systems)');

console.log(`
Done. Public address: ${origin}

Make sure this machine is serving it:
  node hosting/scripts/stack.mjs up --saas-root ${saasRoot} --runtime ${runtime} --frontends none --tunnel quick|named
Then prove it in a browser:
  node hosting/test/saas-flow.mjs --origin ${origin} --password <the administrator password> --playwright-from <sso frontend dir>
`);
