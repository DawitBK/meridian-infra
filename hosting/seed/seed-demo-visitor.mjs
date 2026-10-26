#!/usr/bin/env node
/**
 * The public sandbox login for visitors of the portfolio: ONE system administrator who can open every demo.
 *
 *   node seed-demo-visitor.mjs --saas-root <dir> --apps-root <dir> --runtime <dir> --password <public demo password> [--email demo.admin@examplecorp.com]
 *
 * What it creates (all in the demo databases of this machine, never in a production system):
 *   identity provider : the account, in the administrators' group (the console and every launcher tile), with the administrator role
 *                       in the document system (SYSTEM_ADMIN) and the guest system (super_admin)
 *   Retail OS         : the account with the owner role        Martronics : admin        Library : admin
 *   JobPilot          : the account, who owns the organisation the sign-up creates
 *
 * What it never does:
 *   - make the account a platform administrator (it refuses if the address already is one, in any system)
 *   - touch any other account, or any account's password except this one's
 * Safe to repeat; running it again resets this one account's password (that is also how a vandalised demo is put right).
 * The password is public by design: the page that shows it says so.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const arg = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : d;
};
const saasRoot = arg('saas-root');
const appsRoot = arg('apps-root');
const runtime = arg('runtime');
const password = arg('password');
const email = arg('email', 'demo.admin@examplecorp.com').toLowerCase();
if (!saasRoot || !appsRoot || !runtime || !password) {
  console.error('Usage: seed-demo-visitor.mjs --saas-root <dir> --apps-root <dir> --runtime <dir> --password <password> [--email <address>]');
  process.exit(2);
}
if (password.length < 12) throw new Error('Choose a demo password of at least 12 characters.');

const ssoBackend = path.join(saasRoot, 'sso-saas', 'backend');
const pg = createRequire(path.join(ssoBackend, 'package.json'))('pg');
const { hashPassword: ssoHash } = await import(pathToFileURL(path.join(ssoBackend, 'dist', 'auth', 'password.js')).href);

const infra = Object.fromEntries(
  fs.readFileSync(path.join(runtime, 'infra.env'), 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const PG_PORT = Number(infra.POSTGRES_PORT ?? 5440);
const connect = async (database) => {
  const c = new pg.Client({ host: '127.0.0.1', port: PG_PORT, user: 'postgres', password: infra.POSTGRES_PASSWORD, database, connectionTimeoutMillis: 8000 });
  await c.connect();
  return c;
};

/** Hosted apps older than the platform-administrator change have no such column; then there is nothing to guard or clear. */
const hasPlatformAdmin = async (db) =>
  (await db.query("select 1 from information_schema.columns where table_name = 'users' and column_name = 'platform_admin'")).rowCount > 0;

const ADMIN_GROUP = 'CN=EDAMS_Admins,OU=Groups,DC=examplecorp,DC=com';
const GIVEN = 'Demo';
const FAMILY = 'Administrator';

// ------------------------------------------------------------------------------------------------ identity provider
const sso = await connect('sso_saas');
try {
  const existing = (await sso.query('select id, is_platform_admin from idp_users where lower(email) = $1', [email])).rows[0];
  if (existing?.is_platform_admin) throw new Error(`${email} is a platform administrator; refusing to publish it.`);
  const hash = await ssoHash(password);
  await sso.query('begin');
  let id = existing?.id;
  if (id) {
    await sso.query(
      `update idp_users set password_hash = $1, must_change_password = false, is_active = true, is_platform_admin = false,
         failed_logins = 0, locked_until = null, login_failures_cleared_at = now(), updated_at = now() where id = $2`,
      [hash, id],
    );
  } else {
    id = (
      await sso.query(
        `insert into idp_users (email, email_verified, given_name, family_name, password_hash, source, is_active, must_change_password)
         values ($1, true, $2, $3, $4, 'local', true, false) returning id`,
        [email, GIVEN, FAMILY, hash],
      )
    ).rows[0].id;
  }
  await sso.query('insert into idp_user_groups (user_id, group_dn) values ($1, $2) on conflict do nothing', [id, ADMIN_GROUP]);
  for (const [client, role] of [['edams', 'SYSTEM_ADMIN'], ['gms', 'super_admin']]) {
    await sso.query(
      `insert into idp_client_user_roles (email, client_id, role_name, granted_by) values ($1, $2, $3, 'seed-demo-visitor') on conflict do nothing`,
      [email, client, role],
    );
  }
  await sso.query('commit');
  console.log(`identity provider : ${email} ready (administrators' group, DMS SYSTEM_ADMIN, GMS super_admin)`);
} catch (e) {
  await sso.query('rollback').catch(() => {});
  throw e;
} finally {
  await sso.end();
}

// ------------------------------------------------------------------------------------------------ the four product apps
const APPS = {
  'retail-os': { dir: 'retail-os', db: 'retail_os', role: 'owner' },
  martronics: { dir: 'martronics', db: 'martronics', role: 'admin' },
  library: { dir: 'library-management-system', db: 'library', role: 'admin' },
};

for (const [key, app] of Object.entries(APPS)) {
  const apiDir = path.join(appsRoot, app.dir, 'apps', 'api');
  const mod = await import(pathToFileURL(path.join(apiDir, 'dist', 'auth', 'auth.service.js')).href);
  const hash = await mod.hashPassword(password);
  const db = await connect(app.db);
  try {
    const guard = await hasPlatformAdmin(db);
    const have = (await db.query(`select id${guard ? ', platform_admin' : ''} from users where lower(email) = $1 and deleted_at is null`, [email])).rows[0];
    if (have?.platform_admin) throw new Error(`${email} is a platform administrator in ${key}; refusing.`);
    if (have) {
      await db.query(`update users set password_hash = $1, role = $2${guard ? ', platform_admin = false' : ''} where id = $3`, [hash, app.role, have.id]);
    } else {
      await db.query('insert into users (email, password_hash, first_name, last_name, role) values ($1, $2, $3, $4, $5)', [email, hash, GIVEN, FAMILY, app.role]);
    }
    console.log(`${key.padEnd(17)} : ${email} ready (${app.role})`);
  } finally {
    await db.end();
  }
}

// JobPilot signs people up through its API, which also creates their organisation (they own it).
{
  const apiDir = path.join(appsRoot, 'jobpilot', 'apps', 'api');
  const mod = await import(pathToFileURL(path.join(apiDir, 'dist', 'auth', 'auth.service.js')).href);
  const hash = await mod.hashPassword(password);
  const db = await connect('jobpilot');
  try {
    const guard = await hasPlatformAdmin(db);
    let have = (await db.query(`select id${guard ? ', platform_admin' : ''} from users where lower(email) = $1`, [email])).rows[0];
    if (have?.platform_admin) throw new Error(`${email} is a platform administrator in jobpilot; refusing.`);
    if (!have) {
      const res = await fetch('http://127.0.0.1:16104/api/v1/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: `${password}Aa1!`, fullName: `${GIVEN} ${FAMILY}` }),
      });
      if (!res.ok) throw new Error(`jobpilot register failed: ${res.status} ${await res.text()}`);
      have = (await db.query('select id from users where lower(email) = $1', [email])).rows[0];
    }
    await db.query(`update users set password_hash = $1${guard ? ', platform_admin = false' : ''} where id = $2`, [hash, have.id]);
    console.log(`${'jobpilot'.padEnd(17)} : ${email} ready (owner of its own organisation)`);
  } finally {
    await db.end();
  }
}

console.log('\nDone. The password is public by design; re-run this tool to reset it.');
