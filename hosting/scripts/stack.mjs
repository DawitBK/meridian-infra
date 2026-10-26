#!/usr/bin/env node
/**
 * Runs the hosted SaaS stack on this machine: the three backends, the DMS worker, the nginx entry
 * and, when asked, the three frontends and a Cloudflare tunnel. Everything is a detached process
 * with a log file and a pid file under <runtime>, so it survives the terminal that started it.
 *
 *   node stack.mjs up     --saas-root <dir> --runtime <dir> [--frontends local|none] [--tunnel quick|named|none]
 *                         [--nginx-dir <dir>] [--cloudflared <exe>] [--tunnel-name <name>] [--port-base 15000]
 *   node stack.mjs down   --runtime <dir>
 *   node stack.mjs status --runtime <dir>
 *   node stack.mjs restart <service> --saas-root <dir> --runtime <dir>   (stops that one service, then runs `up`; the others are left running)
 *
 * `up` does not build or migrate: run `node deploy.mjs prepare` first (it does both, idempotently).
 *
 * The identity backend runs under its own supervisor (`start:prod:supervised`, deploy/supervise.cjs): it restarts the process
 * if it crashes or stops answering its health check, and the admin console's System health page reports it as supervised.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const [command = 'status'] = process.argv.slice(2);
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}
const runtime = arg('runtime');
if (!runtime) {
  console.error('--runtime <dir> is required');
  process.exit(2);
}
const saasRoot = arg('saas-root');
const base = Number(arg('port-base', '15000'));
const nginxDir = arg('nginx-dir', process.env.NGINX_DIR ?? 'C:/Tools/nginx');
const cloudflared = arg('cloudflared', process.env.CLOUDFLARED ?? 'C:/Tools/cloudflared/cloudflared.exe');
const frontends = arg('frontends', 'none');
const tunnel = arg('tunnel', 'none');
const tunnelName = arg('tunnel-name');
const entryPort = base + 80;

const logs = path.join(runtime, 'logs');
const pids = path.join(runtime, 'pids');
fs.mkdirSync(logs, { recursive: true });
fs.mkdirSync(pids, { recursive: true });

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function pidOf(name) {
  try {
    return Number(fs.readFileSync(path.join(pids, `${name}.pid`), 'utf8'));
  } catch {
    return null;
  }
}

function start(name, cmd, args, cwd, env = {}) {
  const existing = pidOf(name);
  if (existing && alive(existing)) {
    console.log(`  ${name}: already running (pid ${existing})`);
    return;
  }
  const out = fs.openSync(path.join(logs, `${name}.log`), 'a');
  const child = spawn(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
    shell: process.platform === 'win32' && cmd.endsWith('.cmd'),
  });
  child.unref();
  fs.writeFileSync(path.join(pids, `${name}.pid`), String(child.pid));
  console.log(`  ${name}: started (pid ${child.pid})`);
}

function stop(name) {
  const pid = pidOf(name);
  if (!pid) return;
  if (alive(pid)) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(pid, 'SIGTERM');
    console.log(`  ${name}: stopped (pid ${pid})`);
  }
  fs.rmSync(path.join(pids, `${name}.pid`), { force: true });
}

function listening(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    s.once('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.once('error', () => resolve(false));
    s.setTimeout(1500, () => {
      s.destroy();
      resolve(false);
    });
  });
}

const SERVICES = ['sso-backend', 'gms-backend', 'dms-backend', 'dms-worker', 'sso-frontend', 'gms-frontend', 'dms-frontend', 'nginx', 'tunnel'];

if (command === 'restart') {
  const which = process.argv[3];
  if (!SERVICES.includes(which ?? '')) {
    console.error(`restart needs one of: ${SERVICES.join(', ')}`);
    process.exit(2);
  }
  stop(which);
}

if (command === 'up' || command === 'restart') {
  if (!saasRoot) {
    console.error(`--saas-root is required for ${command}`);
    process.exit(2);
  }
  const root = (...p) => path.join(saasRoot, ...p);
  console.log('Starting the stack');
  start('sso-backend', npm, ['run', 'start:prod:supervised'], root('sso-saas', 'backend'));
  start('gms-backend', npm, ['start'], root('gms-saas', 'backend'));
  start('dms-backend', npm, ['run', 'start:prod'], root('dms-saas', 'backend'));
  start('dms-worker', npm, ['run', 'worker:prod'], root('dms-saas', 'backend'));
  if (frontends === 'local') {
    start('sso-frontend', process.execPath, ['scripts/start-standalone.cjs', String(base + 301)], root('sso-saas', 'frontend'), { NODE_ENV: 'production' });
    start('gms-frontend', npm, ['start'], root('gms-saas', 'frontend'));
    start('dms-frontend', process.execPath, ['scripts/start-standalone.cjs', String(base + 101)], root('dms-saas', 'frontend'), { NODE_ENV: 'production' });
  }
  const conf = path.join(runtime, 'nginx', 'nginx.conf');
  if (!fs.existsSync(conf)) {
    console.error(`  no ${conf}: run render-entry.mjs first`);
    process.exit(1);
  }
  start('nginx', path.join(nginxDir, 'nginx.exe'), ['-p', path.join(runtime, 'nginx'), '-c', conf], path.join(runtime, 'nginx'));
  if (tunnel === 'quick') {
    start('tunnel', cloudflared, ['tunnel', '--url', `http://127.0.0.1:${entryPort}`, '--no-autoupdate'], runtime);
  } else if (tunnel === 'named') {
    if (!tunnelName) {
      console.error('--tunnel-name is required for a named tunnel');
      process.exit(2);
    }
    start('tunnel', cloudflared, ['tunnel', '--no-autoupdate', 'run', tunnelName], runtime);
  }
  console.log('Started. Check with: node stack.mjs status');
} else if (command === 'down') {
  console.log('Stopping the stack');
  for (const s of [...SERVICES].reverse()) stop(s);
} else {
  const ports = {
    'sso-backend': base + 300,
    'gms-backend': base + 200,
    'dms-backend': base + 100,
    nginx: entryPort,
    'sso-frontend': base + 301,
    'gms-frontend': base + 201,
    'dms-frontend': base + 101,
  };
  for (const s of SERVICES) {
    const pid = pidOf(s);
    const up = pid && alive(pid);
    const port = ports[s];
    const listen = port ? ((await listening(port)) ? `listening on ${port}` : `NOT listening on ${port}`) : '';
    console.log(`${s.padEnd(14)} ${up ? `running (pid ${pid})` : 'not running'} ${up ? listen : ''}`);
  }
}
