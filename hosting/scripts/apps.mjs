#!/usr/bin/env node
/**
 * Hosts the four product apps (Retail OS, JobPilot, Martronics, Library) on this machine, next to the SaaS stack:
 * one database and one API process each. Their web apps run on Vercel (vercel/deploy-apps.mjs).
 *
 *   node apps.mjs <command> --apps-root <dir> --runtime <dir> [--only a,b] [more]
 *
 *   prepare   database and role, build the API, write its environment, migrate, create the owner account
 *             --issuer <https://portal/sso>   where people sign in (OpenID Connect)
 *   people    the demo accounts of every app (password given with --password), created directly in each database
 *   sso       register each app as a client of the identity provider, give its people accounts there, add portal tiles
 *             --web-origins '{"retail-os":"https://...","jobpilot":"https://..."}' --saas-root <dir>
 *   up | down | status     the API processes
 *
 * Secrets (database passwords, token keys, client secrets) are generated once and kept in <runtime>/secrets.json.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const command = args[0];
const arg = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i > 0 ? args[i + 1] : d;
};
const appsRoot = arg('apps-root');
const runtime = arg('runtime');
const only = arg('only')?.split(',');
if (!command || !runtime || (command !== 'status' && command !== 'down' && !appsRoot)) {
  console.error('Usage: apps.mjs <prepare|people|sso|up|down|status> --apps-root <dir> --runtime <dir> [--only a,b]');
  process.exit(2);
}

const BASE_PORT = 16100;
/** Everything that differs between the apps. */
export const APPS = {
  'retail-os': {
    dir: 'retail-os', scope: '@retail', port: BASE_PORT + 1, db: 'retail_os', label: 'Retail OS', tile: 'Retail OS: till, stock and books',
    bootstrap: { script: 'owner:bootstrap', email: 'OWNER_EMAIL', password: 'OWNER_PASSWORD' }, extraEnv: { BUSINESS_TIMEZONE: 'Africa/Addis_Ababa' },
    people: [
      ['shop.manager', 'Mia', 'Manager', 'manager'],
      ['shop.accountant', 'Abel', 'Books', 'accountant'],
      ['shop.cashier', 'Cleo', 'Till', 'cashier'],
    ],
    owner: 'owner',
  },
  jobpilot: {
    dir: 'jobpilot', scope: '@jobpilot', port: BASE_PORT + 4, db: 'jobpilot', label: 'JobPilot', tile: 'JobPilot: job search workspace', twoRoles: true,
    people: [
      ['jobseeker.ana', 'Ana', 'Candidate'],
      ['jobseeker.ben', 'Ben', 'Candidate'],
      ['recruiter.rita', 'Rita', 'Recruiter'],
    ],
  },
  martronics: {
    dir: 'martronics', scope: '@martronics', port: BASE_PORT + 3, db: 'martronics', label: 'Martronics', tile: 'Martronics: online shop and admin',
    bootstrap: { script: 'admin:bootstrap', email: 'ADMIN_EMAIL', password: 'ADMIN_PASSWORD' },
    people: [
      ['shop.manager', 'Mara', 'Manager', 'manager'],
      ['customer.dina', 'Dina', 'Buyer', 'customer'],
      ['customer.eli', 'Eli', 'Buyer', 'customer'],
    ],
    owner: 'admin',
  },
  library: {
    dir: 'library-management-system', scope: '@library', port: BASE_PORT + 2, db: 'library', label: 'Library', tile: 'Library: catalogue and circulation desk',
    bootstrap: { script: 'admin:bootstrap', email: 'ADMIN_EMAIL', password: 'ADMIN_PASSWORD' },
    people: [
      ['librarian.lia', 'Lia', 'Librarian', 'librarian'],
      ['librarian.sol', 'Sol', 'Librarian', 'librarian'],
    ],
    owner: 'admin',
  },
};
const selected = Object.entries(APPS).filter(([k]) => !only || only.includes(k));
const OWNER_EMAIL = process.env.SAAS_OWNER_EMAIL ?? 'owner@examplecorp.com';

const secretsFile = path.join(runtime, 'secrets.json');
const secrets = fs.existsSync(secretsFile) ? JSON.parse(fs.readFileSync(secretsFile, 'utf8')) : {};
const secret = (name, bytes = 32) => {
  if (!secrets[name]) {
    secrets[name] = randomBytes(bytes).toString('base64url');
    fs.writeFileSync(secretsFile, JSON.stringify(secrets, null, 2));
  }
  return secrets[name];
};
const infra = Object.fromEntries(
  fs.readFileSync(path.join(runtime, 'infra.env'), 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const PG_PORT = Number(infra.POSTGRES_PORT ?? 5440);
const logs = path.join(runtime, 'logs');
const pids = path.join(runtime, 'pids');
const envDir = path.join(runtime, 'apps');
for (const d of [logs, pids, envDir]) fs.mkdirSync(d, { recursive: true });

const run = (cmd, a, o = {}) => spawnSync(cmd, a, { encoding: 'utf8', shell: process.platform === 'win32', ...o });
const repo = (app) => path.join(appsRoot, app.dir);
const urlFor = (user, pw, db) => `postgres://${user}:${encodeURIComponent(pw)}@127.0.0.1:${PG_PORT}/${db}`;
const dbUser = (key) => key.replace(/[^a-z0-9]/g, '_');
const envFile = (key) => path.join(envDir, `${key}.env`);

function parseEnv(file) {
  return Object.fromEntries(
    fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => /^[A-Z][A-Z0-9_]*=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
}

async function pgAdmin() {
  const pg = createRequire(path.join(repo(APPS['retail-os']), 'apps', 'api', 'package.json'))('pg');
  const c = new pg.Client({ host: '127.0.0.1', port: PG_PORT, user: 'postgres', password: infra.POSTGRES_PASSWORD, database: 'postgres' });
  await c.connect();
  return c;
}

async function connectApp(key, app, asOwner = true) {
  const pg = createRequire(path.join(repo(app), 'apps', 'api', 'package.json'))('pg');
  const c = new pg.Client({ connectionString: urlFor(dbUser(key), secret(`apps.${key}.db`, 18), app.db) });
  await c.connect();
  return c;
}

// ------------------------------------------------------------------------------------------------ prepare
async function prepare() {
  const issuer = arg('issuer');
  const admin = await pgAdmin();
  for (const [key, app] of selected) {
    console.log(`\n== ${key}`);
    const owner = dbUser(key);
    const pw = secret(`apps.${key}.db`, 18);
    const exists = (await admin.query('select 1 from pg_roles where rolname = $1', [owner])).rowCount;
    if (!exists) await admin.query(`create role ${owner} login password '${pw}'`);
    const dbExists = (await admin.query('select 1 from pg_database where datname = $1', [app.db])).rowCount;
    if (!dbExists) await admin.query(`create database ${app.db} owner ${owner}`);
    let runtimeUser = owner;
    let runtimePw = pw;
    if (app.twoRoles) {
      const appRole = `${owner}_app`;
      runtimeUser = appRole;
      runtimePw = secret(`apps.${key}.db.app`, 18);
      if (!(await admin.query('select 1 from pg_roles where rolname = $1', [appRole])).rowCount) {
        await admin.query(`create role ${appRole} login nosuperuser nobypassrls password '${runtimePw}'`);
      }
    }
    console.log('  database ready');

    console.log('  building the API...');
    const build = run('corepack', ['pnpm', '--filter', `${app.scope}/api...`, 'build'], { cwd: repo(app) });
    if (build.status !== 0) throw new Error(`${key}: build failed\n${(build.stdout ?? '').slice(-1500)}\n${(build.stderr ?? '').slice(-1500)}`);

    const env = {
      NODE_ENV: 'production',
      PORT: String(app.port),
      LOG_LEVEL: 'info',
      TRUST_PROXY_HOPS: '1',
      DATABASE_URL: urlFor(runtimeUser, runtimePw, app.db),
      JWT_SECRET: secret(`apps.${key}.jwt`, 48),
      ...(app.twoRoles ? { MIGRATION_DATABASE_URL: urlFor(owner, pw, app.db) } : {}),
      ...(issuer ? { OIDC_ISSUER: issuer, OIDC_CLIENT_ID: key, OIDC_CLIENT_SECRET: secret(`apps.${key}.oidc`, 32) } : {}),
      ...(app.extraEnv ?? {}),
    };
    fs.writeFileSync(envFile(key), Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });

    const apiDir = path.join(repo(app), 'apps', 'api');
    const migrate = spawnSync(process.execPath, ['dist/db/migrate.js'], {
      cwd: apiDir,
      encoding: 'utf8',
      env: { ...process.env, ...env, DATABASE_URL: app.twoRoles ? env.MIGRATION_DATABASE_URL : env.DATABASE_URL, MIGRATION_DATABASE_URL: env.MIGRATION_DATABASE_URL ?? env.DATABASE_URL },
    });
    if (migrate.status !== 0) throw new Error(`${key}: migration failed\n${migrate.stdout}\n${migrate.stderr}`);
    console.log('  migrated');

    if (app.bootstrap) {
      const r = spawnSync(process.execPath, ['dist/bootstrap-admin.js'], {
        cwd: apiDir,
        encoding: 'utf8',
        env: { ...process.env, ...env, [app.bootstrap.email]: OWNER_EMAIL, [app.bootstrap.password]: secret(`apps.${key}.owner`, 18) },
      });
      console.log(`  ${(r.stdout || r.stderr).trim().split('\n').pop()}`);
    }
  }
  await admin.end();
}

// ------------------------------------------------------------------------------------------------ people
async function people() {
  const password = arg('password');
  if (!password) throw new Error('--password is required');
  for (const [key, app] of selected) {
    console.log(`\n== ${key}`);
    const apiDir = path.join(repo(app), 'apps', 'api');
    const mod = await import(pathToFileURL(path.join(apiDir, 'dist', 'auth', 'auth.service.js')).href);
    const hash = await mod.hashPassword(password);
    const db = await connectApp(key, app);
    try {
      if (key === 'jobpilot') {
        const env = parseEnv(envFile(key));
        const base = `http://127.0.0.1:${app.port}`;
        for (const [login, first, last] of [['platform.admin', 'Platform', 'Administrator'], ...app.people]) {
          const email = login.includes('@') ? login : `${login}@examplecorp.com`;
          const have = await db.query('select id from users where email = $1', [email]);
          if (!have.rowCount) {
            const res = await fetch(`${base}/api/v1/auth/register`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ email, password: `${randomBytes(12).toString('base64url')}Aa1!`, fullName: `${first} ${last}` }),
            });
            if (!res.ok) throw new Error(`register ${email} failed: ${res.status} ${await res.text()}`);
          }
          if (email !== OWNER_EMAIL) await db.query('update users set password_hash = $1 where email = $2', [hash, email]);
        }
        // The platform administrator is in no member list and out of reach of everyone else (the app's own rule, see its identity module).
        await db.query('update users set platform_admin = true where email = $1', [OWNER_EMAIL]);
        void env;
      } else {
        // The unique index on email is partial in some apps (live rows only), so ON CONFLICT cannot name it: look first.
        const upsert = async (email, passwordHash, first, last, role, updatePassword) => {
          const have = await db.query('select id from users where email = $1 and deleted_at is null', [email]);
          if (have.rowCount) {
            if (updatePassword) await db.query('update users set password_hash = $1 where id = $2', [passwordHash, have.rows[0].id]);
          } else {
            await db.query('insert into users (email, password_hash, first_name, last_name, role) values ($1, $2, $3, $4, $5)', [email, passwordHash, first, last, role]);
          }
        };
        for (const [login, first, last, role] of app.people) await upsert(`${login}@examplecorp.com`, hash, first, last, role, true);
        // The platform administrator signs in through the identity provider; their password here is the random one from prepare.
        await upsert(OWNER_EMAIL, await mod.hashPassword(secret(`apps.${key}.owner`, 18)), 'Platform', 'Administrator', app.owner, false);
        // The platform administrator is in no staff list and out of reach of everyone else (the app's own rule, see its identity module).
        await db.query('update users set platform_admin = true where email = $1 and deleted_at is null', [OWNER_EMAIL]);
      }
      console.log('  accounts ready');
    } finally {
      await db.end();
    }
  }
}

// ------------------------------------------------------------------------------------------------ sso
async function sso() {
  const saasRoot = arg('saas-root');
  const origins = JSON.parse(arg('web-origins') ?? '{}');
  if (!saasRoot) throw new Error('--saas-root is required');
  const ssoBackend = path.join(saasRoot, 'sso-saas', 'backend');
  const pg = createRequire(path.join(ssoBackend, 'package.json'))('pg');
  const { hashPassword } = await import(pathToFileURL(path.join(ssoBackend, 'dist', 'auth', 'password.js')).href);
  const password = arg('password');
  const hash = password ? await hashPassword(password) : null;
  const clients = [];
  const tiles = [];
  const db = new pg.Client({ host: '127.0.0.1', port: PG_PORT, user: 'postgres', password: infra.POSTGRES_PASSWORD, database: 'sso_saas' });
  await db.connect();
  const ADMIN_GROUP = 'CN=EDAMS_Admins,OU=Groups,DC=examplecorp,DC=com';
  try {
    await db.query('begin');
    for (const [key, app] of selected) {
      const origin = (origins[key] ?? '').replace(/\/+$/, '');
      if (!origin) continue;
      const group = `CN=${key.replace(/-/g, '_')}_Users,OU=Groups,DC=examplecorp,DC=com`;
      const clientSecret = secret(`apps.${key}.oidc`, 32);
      const redirect = `${origin}/login/sso/callback`;
      // backchannel_logout_uri: where the identity provider tells the app (server to server) that a person signed out or was disabled there.
      clients.push({ client_id: key, client_secret: clientSecret, redirect_uris: [redirect], post_logout_redirect_uris: [`${origin}/login`], name: app.label, backchannel_logout_uri: `http://127.0.0.1:${app.port}/api/v1/auth/backchannel-logout` });
      tiles.push({ rp: key, label: app.label, name: app.tile, url: `${origin}/login/sso` });
      await db.query(
        `insert into idp_clients (client_id, client_secret, redirect_uris, post_logout_redirect_uris, name, scope, updated_by)
         values ($1, $2, $3, $4, $5, 'openid profile email', 'apps.mjs')
         on conflict (client_id) do update set client_secret = excluded.client_secret, redirect_uris = excluded.redirect_uris,
           post_logout_redirect_uris = excluded.post_logout_redirect_uris, updated_at = now(), updated_by = 'apps.mjs'`,
        [key, clientSecret, [redirect], [`${origin}/login`], app.label],
      );
      for (const dn of [group, ADMIN_GROUP]) {
        await db.query(`insert into idp_app_entitlements (relying_party, group_dn) values ($1, $2) on conflict do nothing`, [key, dn]);
      }
      const logins = (app.people ?? []).map((p) => `${p[0]}@examplecorp.com`);
      for (const email of logins) {
        const name = email.split('@')[0].split('.');
        await db.query(
          `insert into idp_users (email, email_verified, given_name, family_name, password_hash, source, is_active, must_change_password)
           values ($1, true, $2, $3, $4, 'local', true, false) on conflict (email) do nothing`,
          [email, name[1] ?? name[0], name[0], hash],
        );
        await db.query(`insert into idp_user_groups (user_id, group_dn) select id, $2 from idp_users where email = $1 on conflict do nothing`, [email, group]);
      }
    }
    await db.query('commit');
  } catch (e) {
    await db.query('rollback');
    throw e;
  } finally {
    await db.end();
  }
  // The identity provider reads these at start-up (make-env.mjs writes them into its environment on every prepare).
  const file = path.join(envDir, 'sso.json');
  const previous = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { clients: [], tiles: [] };
  const merge = (a, b, k) => [...a.filter((x) => !b.some((y) => y[k] === x[k])), ...b];
  fs.writeFileSync(file, JSON.stringify({ clients: merge(previous.clients, clients, 'client_id'), tiles: merge(previous.tiles, tiles, 'rp') }, null, 2));
  console.log(`registered ${clients.length} client(s); run prepare.mjs again and restart the identity provider to load them`);
}

// ------------------------------------------------------------------------------------------------ processes
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const pidOf = (name) => {
  try {
    return Number(fs.readFileSync(path.join(pids, `${name}.pid`), 'utf8'));
  } catch {
    return null;
  }
};
const listening = (port) =>
  new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('error', () => resolve(false));
    s.setTimeout(1500, () => (s.destroy(), resolve(false)));
  });

function up() {
  for (const [key, app] of selected) {
    const name = `app-${key}`;
    const existing = pidOf(name);
    if (existing && alive(existing)) {
      console.log(`  ${name}: already running (pid ${existing})`);
      continue;
    }
    if (!fs.existsSync(envFile(key))) {
      console.log(`  ${name}: no environment file, run prepare first`);
      continue;
    }
    const out = fs.openSync(path.join(logs, `${name}.log`), 'a');
    const child = spawn(process.execPath, ['dist/main.js'], {
      cwd: path.join(repo(app), 'apps', 'api'),
      env: { ...process.env, ...parseEnv(envFile(key)) },
      detached: true,
      stdio: ['ignore', out, out],
      windowsHide: true,
    });
    child.unref();
    fs.writeFileSync(path.join(pids, `${name}.pid`), String(child.pid));
    console.log(`  ${name}: started (pid ${child.pid}) on ${app.port}`);
  }
}

function down() {
  for (const [key] of selected) {
    const name = `app-${key}`;
    const pid = pidOf(name);
    if (pid && alive(pid)) {
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
      else process.kill(pid, 'SIGTERM');
      console.log(`  ${name}: stopped (pid ${pid})`);
    }
    fs.rmSync(path.join(pids, `${name}.pid`), { force: true });
  }
}

async function status() {
  for (const [key, app] of selected) {
    const pid = pidOf(`app-${key}`);
    console.log(`${`app-${key}`.padEnd(24)} ${pid && alive(pid) ? `running (pid ${pid})` : 'not running'} ${(await listening(app.port)) ? `listening on ${app.port}` : ''}`);
  }
}

const commands = { prepare, people, sso, up, down, status };
if (!commands[command]) {
  console.error(`Unknown command ${command}`);
  process.exit(2);
}
await commands[command]();
