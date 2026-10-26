#!/usr/bin/env node
/**
 * Gets the three SaaS editions ready to run on this machine, safely to repeat:
 *
 *   node prepare.mjs --saas-root <dir> --runtime <dir> --origin https://portal.example.com
 *                    [--backend-origin https://api.example.com] [--mos-origin https://mos.example.com] [--frontends local|none] [--infra <dir>]
 *
 *  1. creates the data-plane passwords once (kept in <runtime>, outside git) and starts the data plane
 *  2. installs dependencies where they are missing
 *  3. writes the env files for the given origin (secrets are kept; only addresses change)
 *  4. builds the backends, migrates the three databases, seeds them once (reference data and the
 *     first administrator, whose password is generated once and printed once)
 *  5. with --frontends local, builds the frontends for this origin (a different origin means a
 *     rebuild: addresses are baked into a Next.js build)
 *
 * Then: node stack.mjs up ...   and   node ../test/saas-flow.mjs ... to prove it works.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}
const here = path.dirname(fileURLToPath(import.meta.url));
const saasRoot = arg('saas-root');
const runtime = arg('runtime');
const origin = (arg('origin') ?? '').replace(/\/+$/, '');
const backendOrigin = (arg('backend-origin') ?? '').replace(/\/+$/, '');
const frontends = arg('frontends', 'none');
const mosOrigin = (arg('mos-origin') ?? '').replace(/\/+$/, '');
const infraDir = arg('infra', path.resolve(here, '..'));
if (!saasRoot || !runtime || !origin) {
  console.error('Usage: prepare.mjs --saas-root <dir> --runtime <dir> --origin <https://host> [--backend-origin <https://host>] [--frontends local|none]');
  process.exit(2);
}
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const root = (...p) => path.join(saasRoot, ...p);
fs.mkdirSync(runtime, { recursive: true });

function run(label, cmd, args, cwd, env = {}) {
  console.log(`\n== ${label}`);
  const r = spawnSync(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: 'inherit',
    shell: process.platform === 'win32' && cmd.endsWith('.cmd'),
  });
  if (r.status !== 0) {
    console.error(`\n${label} failed (exit ${r.status}).`);
    process.exit(r.status ?? 1);
  }
}

// ---- 1. the data plane
const infraEnv = path.join(runtime, 'infra.env');
if (!fs.existsSync(infraEnv)) {
  const r = () => randomBytes(24).toString('base64url');
  fs.writeFileSync(
    infraEnv,
    `POSTGRES_PASSWORD=${r()}\nEDAMS_APP_DB_PASSWORD=${r()}\nVALKEY_PASSWORD=${r()}\nMINIO_ROOT_PASSWORD=${r()}\n`,
    { mode: 0o600 },
  );
  console.log(`created ${infraEnv}`);
}
run('data plane (PostgreSQL 18, Valkey, MinIO)', 'docker', ['compose', '--env-file', infraEnv, 'up', '-d', '--wait'], infraDir);

// ---- 2. dependencies
const packages = [
  [root('gms-saas', 'backend'), 'gms backend'],
  [root('gms-saas', 'frontend'), 'gms frontend'],
  [root('sso-saas', 'backend'), 'sso backend'],
  [root('sso-saas', 'frontend'), 'sso frontend'],
  [root('dms-saas'), 'dms (workspace: backend and frontend)'],
];
for (const [dir, label] of packages) {
  if (!fs.existsSync(path.join(dir, 'node_modules'))) {
    run(`install ${label}`, npm, ['ci', '--no-audit', '--no-fund', '--fetch-retries=6'], dir);
  }
}

// ---- 3. env files
const makeEnvArgs = [path.join(here, 'make-env.mjs'), '--saas-root', saasRoot, '--origin', origin, '--infra-env', infraEnv];
if (backendOrigin) makeEnvArgs.push('--backend-origin', backendOrigin);
if (mosOrigin) makeEnvArgs.push('--mos-origin', mosOrigin);
run('env files', process.execPath, makeEnvArgs, here);

const secrets = JSON.parse(fs.readFileSync(path.join(runtime, 'secrets.json'), 'utf8'));
const state = path.join(runtime, 'state.json');
const done = fs.existsSync(state) ? JSON.parse(fs.readFileSync(state, 'utf8')) : {};

// ---- 4. backends: build, migrate, seed once
run('build gms backend', npm, ['run', 'build'], root('gms-saas', 'backend'));
run('build sso backend', npm, ['run', 'build'], root('sso-saas', 'backend'));
run('build dms backend', npm, ['run', 'build'], root('dms-saas', 'backend'));
run('migrate gms', npm, ['run', 'migrate:prod'], root('gms-saas', 'backend'));
run('migrate sso', npm, ['run', 'db:migrate:prod'], root('sso-saas', 'backend'));
run('migrate dms', npm, ['run', 'db:migrate:prod'], root('dms-saas', 'backend'));

if (!done.seeded) {
  secrets['admin.password'] ??= randomBytes(15).toString('base64url');
  fs.writeFileSync(path.join(runtime, 'secrets.json'), JSON.stringify(secrets, null, 2), { mode: 0o600 });
  const pw = secrets['admin.password'];
  run('seed gms (system roles and the first administrators)', process.execPath, ['scripts/run-sequelize-cli.js', 'production', 'db:seed', '--seed', '000-core-seeder.js'], root('gms-saas', 'backend'), { GMS_SEED_ADMIN_PASSWORD: pw });
  run('seed sso (the first administrators)', npm, ['run', 'db:seed:dev:prod'], root('sso-saas', 'backend'), { SEED_ADMIN_PASSWORD: pw, SEED_MASTER_PASSWORD: pw });
  run('seed dms (reference data: roles, mappings; no demo users)', npm, ['run', 'db:seed:reference:prod'], root('dms-saas', 'backend'));
  fs.writeFileSync(state, JSON.stringify({ ...done, seeded: true }, null, 2));
  console.log(`\nFirst administrator: admin@examplecorp.com   password: ${pw}\n(also stored in ${path.join(runtime, 'secrets.json')}; sign in once and change it)`);
}

// SSO keeps the redirect addresses it was first started with; point them at this origin.
run('sso client addresses', npm, ['run', 'client:uris:prod', '--', '--apply'], root('sso-saas', 'backend'), { I_UNDERSTAND_THIS_UPDATES: 'sso_saas' });

// ---- 5. frontends
if (frontends === 'local') {
  run('build gms frontend', npm, ['run', 'build'], root('gms-saas', 'frontend'));
  run('build sso frontend', npm, ['run', 'build'], root('sso-saas', 'frontend'));
  run('build dms frontend', npm, ['run', 'build'], root('dms-saas', 'frontend'));
}

console.log('\nPrepared. Next: render the nginx entry, then start the stack:');
console.log(`  node ${path.join(here, '..', 'nginx', 'render-entry.mjs')} --out ${path.join(runtime, 'nginx')} --frontends ${frontends}`);
console.log(`  node ${path.join(here, 'stack.mjs')} up --saas-root ${saasRoot} --runtime ${runtime} --frontends ${frontends} --tunnel quick|named|none`);
