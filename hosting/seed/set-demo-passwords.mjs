#!/usr/bin/env node
/**
 * Sets one password on every account that has one in the neutral editions, EXCEPT the platform administrator.
 *
 *   node set-demo-passwords.mjs --saas-root <dir> --runtime <dir> --password <password>
 *
 *   identity provider : every account, with the platform administrator left alone
 *   guest system      : every account that already has a password (guests who sign in by one-time code have none and stay that way)
 *   document system   : nothing to do - its accounts sign in through the identity provider; the hash it stores is a random placeholder
 *
 * Unlocks any locked account and clears "must change password". Shared passwords are for demos only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const arg = (n) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const saasRoot = arg('saas-root');
const runtime = arg('runtime');
const password = arg('password');
if (!saasRoot || !runtime || !password) {
  console.error('Usage: set-demo-passwords.mjs --saas-root <dir> --runtime <dir> --password <password>');
  process.exit(2);
}

const ssoBackend = path.join(saasRoot, 'sso-saas', 'backend');
const gmsBackend = path.join(saasRoot, 'gms-saas', 'backend');
const pg = createRequire(path.join(ssoBackend, 'package.json'))('pg');
const bcrypt = createRequire(path.join(gmsBackend, 'package.json'))('bcryptjs');
const { hashPassword } = await import(pathToFileURL(path.join(ssoBackend, 'dist', 'auth', 'password.js')).href);

const infra = Object.fromEntries(
  fs.readFileSync(path.join(runtime, 'infra.env'), 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const connect = async (database) => {
  const c = new pg.Client({ host: '127.0.0.1', port: Number(infra.POSTGRES_PORT ?? 5440), user: 'postgres', password: infra.POSTGRES_PASSWORD, database });
  await c.connect();
  return c;
};

const sso = await connect('sso_saas');
const gms = await connect('gms_saas');
try {
  const keep = (await sso.query('select email from idp_users where is_platform_admin')).rows.map((r) => r.email.toLowerCase());
  const ssoHash = await hashPassword(password);
  const a = await sso.query(
    `update idp_users set password_hash = $1, must_change_password = false, failed_logins = 0, locked_until = null,
       login_failures_cleared_at = now(), updated_at = now() where not is_platform_admin`,
    [ssoHash],
  );
  const gmsHash = bcrypt.hashSync(password, 10);
  const b = await gms.query(
    `update users set password_hash = $1, requires_password_change = false where password_hash is not null and lower(email) <> all($2::text[])`,
    [gmsHash, keep],
  );
  console.log(`identity provider: ${a.rowCount} accounts; guest system: ${b.rowCount} accounts; platform administrator left alone (${keep.length}).`);
} finally {
  await Promise.all([sso.end(), gms.end()]);
}
