#!/usr/bin/env node
/**
 * Writes the production env files for the three SaaS editions from their own committed templates.
 *
 *   node make-env.mjs --saas-root <folder holding sso-saas, dms-saas, gms-saas>
 *                     --origin https://portal.example.com        (the ONE public address, no path)
 *                     --infra-env <runtime>/saas/infra.env        (passwords of the data plane)
 *                     [--secrets <runtime>/saas/secrets.json]     (generated once, kept outside git)
 *                     [--backend-origin https://tunnel.example.com]  where the PC's backends are reachable
 *                                                                from outside (omit when one nginx on this
 *                                                                PC serves everything at --origin)
 *
 * How it works: each template line is kept as is, except keys this script sets (addresses, the
 * database, secrets). A template value that still reads like a placeholder and was not set here is
 * an error, so a file never ships with "replace-with-..." in it. Secrets are generated once and
 * stored in `secrets.json` outside every repository; running again with another origin rewrites
 * the addresses and keeps the secrets (sessions and encrypted data stay valid).
 *
 * The files it writes are git-ignored in the three repositories and must never be committed.
 */
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}
const saasRoot = arg('saas-root');
const origin = (arg('origin') ?? '').replace(/\/+$/, '');
const infraEnvPath = arg('infra-env');
if (!saasRoot || !origin || !infraEnvPath) {
  console.error('Usage: make-env.mjs --saas-root <dir> --origin <https://host> --infra-env <file> [--secrets <file>]');
  process.exit(2);
}
if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(origin)) {
  console.error(`--origin must be an https origin without a path, got "${origin}"`);
  process.exit(2);
}
const backendOrigin = (arg('backend-origin') ?? '').replace(/\/+$/, '');
// Where MOS (Odoo) is reachable in a browser. When given, the identity provider registers the gated "mos" client.
const mosOrigin = (arg('mos-origin') ?? '').replace(/\/+$/, '');
// Where the identity provider reaches MOS server to server (to tell it a person signed out); MOS runs next to this stack, not behind the public address.
const mosInternal = (arg('mos-internal') ?? 'http://127.0.0.1:8069').replace(/\/+$/, '');
const secretsPath = arg('secrets', path.join(path.dirname(infraEnvPath), 'secrets.json'));
const infra = Object.fromEntries(
  fs
    .readFileSync(infraEnvPath, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const PG = { host: '127.0.0.1', port: arg('pg-port', '5440') };
const VALKEY_PORT = arg('valkey-port', '6390');
// The systems' own development servers use 7100-7301; this stack lives well away from them.
const base = Number(arg('port-base', '15000'));
export const P = { dmsApi: base + 100, dmsFe: base + 101, gmsApi: base + 200, gmsFe: base + 201, ssoApi: base + 300, ssoFe: base + 301, gateway: base + 400 };
const MINIO_PORT = arg('minio-port', '9090');

const secrets = fs.existsSync(secretsPath) ? JSON.parse(fs.readFileSync(secretsPath, 'utf8')) : {};
// Outbound mail. <runtime>/smtp.json (never in git) holds { host, port, user, pass, address, names: { gms, dms, mos } }.
// Without it the systems get a placeholder mail server and send nothing.
const productSsoFile = path.join(path.dirname(secretsPath), 'apps', 'sso.json');
const productSso = fs.existsSync(productSsoFile) ? JSON.parse(fs.readFileSync(productSsoFile, 'utf8')) : null;
const smtpFile = path.join(path.dirname(secretsPath), 'smtp.json');
const smtp = fs.existsSync(smtpFile) ? JSON.parse(fs.readFileSync(smtpFile, 'utf8')) : null;
const secret =(name, bytes = 32) => (secrets[name] ??= randomBytes(bytes).toString('base64url'));
const rsa = () => {
  if (!secrets['rsa']) {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    secrets['rsa'] = {
      private: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64'),
      public: Buffer.from(publicKey.export({ type: 'spki', format: 'pem' })).toString('base64'),
    };
  }
  return secrets['rsa'];
};

const PLACEHOLDER = /replace[-_]with|must-match|your_password|change-me|change-this|^replace/i;

/** Keep the template's lines, set what we know, append what the template does not list. */
function build(templatePath, values, target) {
  const lines = fs.readFileSync(templatePath, 'utf8').split(/\r?\n/);
  const seen = new Set();
  const out = [];
  for (const line of lines) {
    const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!m) {
      out.push(line);
      continue;
    }
    const [, key, raw] = m;
    seen.add(key);
    if (key in values) {
      // null removes the line: the setting is simply not defined.
      if (values[key] !== null) out.push(`${key}=${values[key]}`);
    } else if (PLACEHOLDER.test(raw.replace(/\s+#.*$/, ''))) {
      throw new Error(`${path.basename(templatePath)}: ${key} is a placeholder and make-env does not set it`);
    } else {
      out.push(line);
    }
  }
  const extra = Object.entries(values).filter(([k]) => !seen.has(k));
  if (extra.length) {
    out.push('', '# ---- set by make-env.mjs (not in the template) ----');
    for (const [k, v] of extra) out.push(`${k}=${v}`);
  }
  fs.writeFileSync(target, out.join('\n').replace(/\n*$/, '\n'), { mode: 0o600 });
  console.log(`wrote ${target}`);
}

const pgUrl = (db, user = 'postgres', pw = infra.POSTGRES_PASSWORD) =>
  `postgresql://${user}:${encodeURIComponent(pw)}@${PG.host}:${PG.port}/${db}`;
const valkey = `redis://:${encodeURIComponent(infra.VALKEY_PASSWORD)}@127.0.0.1:${VALKEY_PORT}`;

// Secrets that two systems must agree on are named once and used by both.
const shared = {
  dmsInternal: secret('shared.DMS_INTERNAL_API_KEY'),
  gmsInternal: secret('shared.GMS_INTERNAL_API_KEY'),
  ssoRoles: secret('shared.SSO_ROLES_API_KEY'),
  edamsClient: secret('shared.EDAMS_CLIENT_SECRET'),
};

const root = (name) => path.join(saasRoot, name);

// ---------------------------------------------------------------- SSO
build(
  path.join(root('sso-saas'), 'backend', '.env.production.example'),
  {
    NODE_ENV: 'production',
    PORT: String(P.ssoApi),
    IDP_ISSUER: `${origin}/sso`,
    IDP_INTERNAL_URL: `http://127.0.0.1:${P.ssoApi}`,
    DATABASE_URL: pgUrl('sso_saas'),
    REDIS_URL: valkey,
    TRUST_PROXY_HOPS: '1',
    COOKIE_KEYS: `${secret('sso.cookie1')},${secret('sso.cookie2')}`,
    TOTP_ENCRYPTION_KEY: secret('sso.totp'),
    IDP_AUDIT_HMAC_SECRET: secret('sso.audit'),
    LOGIN_LOCKOUT_ENABLED: 'true',
    DMS_OIDC_AUTHORIZE_URL: `${origin}/dms/api/v1/auth/oidc/authorize`,
    DMS_BACKCHANNEL_LOGOUT_URI: `${origin}/dms/api/v1/auth/backchannel-logout`,
    DMS_API_BASE_URL: `http://127.0.0.1:${P.dmsApi}/api/v1`,
    DMS_INTERNAL_API_KEY: shared.dmsInternal,
    EDAMS_CLIENT_SECRET: shared.edamsClient,
    EDAMS_REDIRECT_URIS: `${origin}/dms/auth/callback`,
    EDAMS_LOGOUT_URIS: `${origin}/dms/login`,
    GMS_CLIENT_SECRET: secret('sso.GMS_CLIENT_SECRET'),
    GMS_REDIRECT_URIS: `${origin}/sso/bridge/gms/callback`,
    GMS_LOGOUT_URIS: `${origin}/gms/login`,
    PORTAL_CLIENT_SECRET: secret('sso.PORTAL_CLIENT_SECRET'),
    GMS_INTERNAL_API_KEY: shared.gmsInternal,
    GMS_FRONTEND_URL: `${origin}/gms`,
    // SSO calls the GMS API from this same machine, so it goes over loopback, not out and back in.
    GMS_API_BASE: `http://127.0.0.1:${P.gmsApi}/api/v1`,
    SSO_ROLES_API_KEY: shared.ssoRoles,
    GATEWAY_PORT: String(P.gateway),
    GATEWAY_URL: `${origin}/gms`,
    GMS_FRONTEND_TARGET: `http://127.0.0.1:${P.gmsFe}`,
    GMS_API_TARGET: `http://127.0.0.1:${P.gmsApi}`,
    METRICS_API_KEY: secret('sso.metrics'),
    // Owner verification (migration 027): the key file that seals the owner's questions and recovery codes. It lives next to
    // the secrets, outside every repository; `npm run owner:enroll` (run by the owner at a terminal) creates it.
    OWNER_STORE_KEY_FILE: path.join(path.dirname(infraEnvPath), 'owner-store.key'),
    // Product apps registered by hosting/scripts/apps.mjs (Retail OS, JobPilot, Martronics, Library).
    ...(productSso
      ? { PRODUCT_CLIENTS_JSON: JSON.stringify(productSso.clients), PRODUCT_APPS_JSON: JSON.stringify(productSso.tiles) }
      : {}),
    ...(mosOrigin
      ? {
          MOS_ENABLED: 'true',
          MOS_CLIENT_SECRET: secret('mos.client_secret'),
          MOS_REDIRECT_URIS: `${mosOrigin}/mos/oidc/callback`,
          MOS_LOGOUT_URIS: `${mosOrigin}/odoo`,
          MOS_PORTAL_URL: `${mosOrigin}/mos/oidc/login`,
          MOS_BACKCHANNEL_LOGOUT_URI: `${mosInternal}/mos/oidc/backchannel-logout`,
        }
      : {}),
  },
  path.join(root('sso-saas'), 'backend', '.env.production'),
);
build(
  path.join(root('sso-saas'), 'frontend', '.env.production.example'),
  {
    NEXT_PUBLIC_BASE_PATH: '/sso',
    // The frontend's server proxies the identity API to this address. On this machine that is
    // loopback; when the frontend runs on Vercel it is the tunnel address of the nginx entry.
    SSO_BACKEND_URL: backendOrigin ? `${backendOrigin}/sso-backend` : `http://127.0.0.1:${P.ssoApi}`,
    NEXT_PUBLIC_APP_ORIGIN: origin,
  },
  path.join(root('sso-saas'), 'frontend', '.env.production'),
);

// ---------------------------------------------------------------- GMS
build(
  path.join(root('gms-saas'), 'backend', '.env.example'),
  {
    NODE_ENV: 'production',
    PORT: String(P.gmsApi),
    HOST: '127.0.0.1',
    CLIENT_URL: `${origin}/gms`,
    CORS_ALLOWED_ORIGINS: origin,
    DB_HOST: PG.host,
    DB_PORT: PG.port,
    DB_USER: 'postgres',
    DB_PASSWORD: infra.POSTGRES_PASSWORD,
    DB_NAME: 'gms_saas',
    REDIS_URL: valkey,
    JWT_SECRET: secret('gms.jwt'),
    JWT_REFRESH_SECRET: secret('gms.jwtRefresh'),
    SSO_INTERNAL_API_KEY: shared.gmsInternal,
    SSO_API_BASE: `http://127.0.0.1:${P.ssoApi}`,
    LICENSE_SSO_URL: `http://127.0.0.1:${P.ssoApi}`,
    SSO_ROLES_API_KEY: shared.ssoRoles,
    SMTP_HOST: smtp ? smtp.host : 'smtp.invalid',
    SMTP_PORT: smtp ? String(smtp.port) : '587',
    SMTP_USER: smtp ? smtp.user : 'noreply@example.invalid',
    SMTP_PASS: smtp ? smtp.pass : secret('gms.smtpPlaceholder', 12),
    FROM_EMAIL: smtp ? smtp.address : 'noreply@example.invalid',
    SMTP_FROM_NAME: smtp ? smtp.names.gms : null,
    // SMTP is the mail route; leaving SendGrid's sender set would demand a SendGrid key.
    SENDGRID_FROM_EMAIL: null,
    UNIFI_ACCESS_API_KEY: 'not-configured',
    UNIFI_ACCESS_WEBHOOK_SECRET: secret('gms.unifiWebhook'),
    ENABLE_UNIFI_ACCESS_POLLING: 'false',
    TRUST_PROXY: '1',
  },
  path.join(root('gms-saas'), 'backend', '.env.production'),
);
build(
  path.join(root('gms-saas'), 'frontend', '.env.example'),
  {
    PORT: String(P.gmsFe),
    HOSTNAME: '127.0.0.1',
    NEXT_PUBLIC_BASE_PATH: '/gms',
    NEXT_PUBLIC_API_BASE_URL: `${origin}/api/v1`,
    NEXT_PUBLIC_SOCKET_URL: origin,
    NEXT_PUBLIC_APP_URL: `${origin}/gms`,
    NEXT_PUBLIC_SSO_LOGIN_URL: `${origin}/sso/bridge/gms/start`,
    NEXT_PUBLIC_ENABLE_LIVE_DEMO: 'true',
  },
  path.join(root('gms-saas'), 'frontend', '.env.production'),
);

// ---------------------------------------------------------------- DMS
const keys = rsa();
build(
  path.join(root('dms-saas'), 'backend', '.env.example'),
  {
    NODE_ENV: 'production',
    DB_HOST: PG.host,
    DB_PORT: PG.port,
    DB_USER: 'edams_app',
    DB_PASSWORD: infra.EDAMS_APP_DB_PASSWORD,
    PORT: String(P.dmsApi),
    DB_NAME: 'dms_saas',
    DB_MIGRATE_USER: 'postgres',
    DB_MIGRATE_PASSWORD: infra.POSTGRES_PASSWORD,
    AUDIT_HMAC_SECRET: secret('dms.audit'),
    REDIS_URL: valkey,
    MINIO_ENDPOINT: '127.0.0.1',
    MINIO_PORT,
    MINIO_ACCESS_KEY: infra.MINIO_ROOT_USER ?? 'saasminio',
    MINIO_SECRET_KEY: infra.MINIO_ROOT_PASSWORD,
    MINIO_USE_SSL: 'false',
    STORAGE_DRIVER: 'minio',
    SEARCH_ENGINE: 'postgres',
    SMTP_HOST: smtp ? smtp.host : 'smtp.invalid',
    SMTP_PORT: smtp ? String(smtp.port) : '587',
    SMTP_USER: smtp ? smtp.user : 'noreply@example.invalid',
    SMTP_PASS: smtp ? smtp.pass : secret('dms.smtpPlaceholder', 12),
    EMAIL_FROM: smtp ? `"${smtp.names.dms}" <${smtp.address}>` : 'DMS <noreply@example.invalid>',
    CLAMAV_ENABLED: 'false',
    ENABLE_QUEUE_WORKERS: 'true',
    ENABLE_OUTBOX_POLLING: 'true',
    ENABLE_API_DOCS: 'false',
    // The browser-visible prefix: the proxy strips /dms, so the app cannot infer it (cookie paths).
    PUBLIC_BASE_PATH: '/dms',
    CLIENT_URL: `${origin}/dms`,
    CORS_ORIGINS: origin,
    DMS_INTERNAL_API_KEY: shared.dmsInternal,
    OIDC_CLIENT_ID: 'edams',
    OIDC_CLIENT_SECRET: shared.edamsClient,
    OIDC_REDIRECT_URI: `${origin}/dms/auth/callback`,
    OIDC_TOKEN_ENDPOINT: `http://127.0.0.1:${P.ssoApi}/token`,
    CAMS_VERIFY_BASE_URL: `${origin}/dms/verify`,
    LOCAL_JWT_MOCK: 'false',
    AUTH_ISSUER: `${origin}/sso`,
    AUTH_AUDIENCE: 'edams-api',
    AUTH_JWKS_URI: `http://127.0.0.1:${P.ssoApi}/jwks`,
    LICENSE_SSO_URL: `http://127.0.0.1:${P.ssoApi}`,
    DEV_VAULT_MOCK: 'false',
    VAULT_BACKEND: 'env',
    VAULT_MASTER_KEY: secret('dms.vaultMaster'),
    VAULT_MASTER_KEY_CURRENT_VERSION: '1',
    JWT_SECRET: secret('dms.jwt'),
    JWT_REFRESH_SECRET: secret('dms.jwtRefresh'),
    DEV_RSA_PRIVATE_KEY: keys.private,
    DEV_RSA_PUBLIC_KEY: keys.public,
    ADMIN_ALERT_EMAIL_TO: 'admin@example.invalid',
    // These take priority over AUTH_ISSUER/AUTH_AUDIENCE when signing, so production refuses them.
    DEV_JWT_ISSUER: null,
    DEV_JWT_AUDIENCE: null,
    TRUST_PROXY: '1',
  },
  path.join(root('dms-saas'), 'backend', '.env.production'),
);
build(
  path.join(root('dms-saas'), 'frontend', '.env.development.example'),
  {
    NEXT_PUBLIC_BASE_PATH: '/dms',
    NEXT_PUBLIC_API_BASE_URL: `${origin}/dms/api/v1`,
    NEXT_PUBLIC_SOCKET_URL: origin,
    NEXT_PUBLIC_DEV_LOGIN: 'false',
  },
  path.join(root('dms-saas'), 'frontend', '.env.production'),
);

fs.mkdirSync(path.dirname(secretsPath), { recursive: true });
fs.writeFileSync(secretsPath, JSON.stringify(secrets, null, 2), { mode: 0o600 });
console.log(
  `\nOrigin ${origin}. Secrets are in ${secretsPath} (${createHash('sha256').update(JSON.stringify(secrets)).digest('hex').slice(0, 8)}); keep that file out of git.`,
);
