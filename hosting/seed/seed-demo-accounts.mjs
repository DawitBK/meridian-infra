#!/usr/bin/env node
/**
 * Gives the people already seeded into the document system (DMS) and the guest system (GMS) a sign-in at
 * the identity provider, so the demo can actually be walked through as an administrator, a records officer,
 * an approver, a receptionist, a host and so on.
 *
 *   node seed-demo-accounts.mjs --saas-root <dir> --runtime <dir>
 *
 * Reads the staff from the two databases (never the guests), writes to the identity database only:
 *   - one account per person, one shared demo password (<runtime>/secrets.json, key demo.password)
 *   - membership of one demo group, which is entitled to open both systems from the portal
 *   - the person's role in each system (and the GMS office for office-scoped roles)
 * Safe to repeat. It changes no existing account's password except the demo ones it created itself.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}
const saasRoot = arg('saas-root');
const runtime = arg('runtime');
if (!saasRoot || !runtime) {
  console.error('Usage: seed-demo-accounts.mjs --saas-root <dir> --runtime <dir>');
  process.exit(2);
}

const ssoBackend = path.join(saasRoot, 'sso-saas', 'backend');
const require = createRequire(path.join(ssoBackend, 'package.json'));
const pg = require('pg');
const { hashPassword } = await import(pathToFileURL(path.join(ssoBackend, 'dist', 'auth', 'password.js')).href);

const secrets = JSON.parse(fs.readFileSync(path.join(runtime, 'secrets.json'), 'utf8'));
const demoPassword = secrets['demo.password'];
const infra = Object.fromEntries(
  fs.readFileSync(path.join(runtime, 'infra.env'), 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
if (!demoPassword) throw new Error('secrets.json has no demo.password');

const connect = async (database) => {
  const c = new pg.Client({ host: '127.0.0.1', port: Number(infra.POSTGRES_PORT ?? 5440), user: 'postgres', password: infra.POSTGRES_PASSWORD, database });
  await c.connect();
  return c;
};

const GROUP = 'CN=Demo_Users,OU=Groups,DC=examplecorp,DC=com';

const dms = await connect('dms_saas');
const gms = await connect('gms_saas');
const sso = await connect('sso_saas');

const people = new Map(); // email -> { given, family, dms?, gms?, office? }
const person = (email, given, family) => {
  const key = email.toLowerCase();
  if (!people.has(key)) people.set(key, { email: key, given: given || 'Demo', family: family || 'User' });
  return people.get(key);
};

for (const r of (await dms.query(`select u.email, u.first_name, u.last_name, r.name as role from users u join user_roles ur on ur.user_id = u.id join roles r on r.id = ur.role_id`)).rows) {
  person(r.email, r.first_name, r.last_name).dms = r.role;
}
for (const r of (await gms.query(`select u.email, u.full_name, u.office_id, r.name as role from users u join user_roles ur on ur.user_id = u.id join roles r on r.id = ur.role_id where r.name <> 'guest'`)).rows) {
  const [given, ...rest] = String(r.full_name ?? '').split(' ');
  const p = person(r.email, given, rest.join(' '));
  p.gms = r.role;
  if (r.office_id != null) p.office = Number(r.office_id);
}

// Accounts that already exist in the identity provider keep their password and their roles' owner.
const existing = new Set((await sso.query(`select email from idp_users`)).rows.map((r) => r.email.toLowerCase()));
const hash = await hashPassword(demoPassword);

await sso.query('begin');
try {
  await sso.query(`insert into idp_app_entitlements (relying_party, group_dn) values ('edams', $1), ('gms', $1) on conflict do nothing`, [GROUP]);
  let created = 0;
  for (const p of people.values()) {
    if (!existing.has(p.email)) {
      await sso.query(
        `insert into idp_users (email, email_verified, given_name, family_name, password_hash, source, is_active, must_change_password)
         values ($1, true, $2, $3, $4, 'local', true, false)`,
        [p.email, p.given, p.family, hash],
      );
      created += 1;
    }
    if (existing.has(p.email) && !(p.dms || p.gms)) continue;
    if (!existing.has(p.email)) {
      const { rows } = await sso.query(`select id from idp_users where email = $1`, [p.email]);
      await sso.query(`insert into idp_user_groups (user_id, group_dn) values ($1, $2) on conflict do nothing`, [rows[0].id, GROUP]);
      if (p.dms) await sso.query(`insert into idp_client_user_roles (email, client_id, role_name, granted_by) values ($1, 'edams', $2, 'seed-demo-accounts') on conflict do nothing`, [p.email, p.dms]);
      if (p.gms) await sso.query(`insert into idp_client_user_roles (email, client_id, role_name, granted_by) values ($1, 'gms', $2, 'seed-demo-accounts') on conflict do nothing`, [p.email, p.gms]);
      if (p.gms && p.office != null) await sso.query(`insert into idp_gms_user_office (email, office_id) values ($1, $2) on conflict do nothing`, [p.email, p.office]);
    }
  }
  await sso.query('commit');
  console.log(`${people.size} staff found; ${created} identity accounts created, ${people.size - created} already existed.`);
} catch (e) {
  await sso.query('rollback');
  throw e;
} finally {
  await Promise.all([dms.end(), gms.end(), sso.end()]);
}
