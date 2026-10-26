# The SaaS editions on Vercel, with this PC as the host

What runs where, why, and the exact steps. Everything below was run end to end on this machine
behind a public HTTPS address (sign in at the identity provider, then open the document system and
the guest system without signing in again; `hosting/test/saas-flow.mjs`). The only step not run here
is the Vercel deployment itself, because it needs your Vercel account.

## Where each piece runs

| Piece                                                        | Where                      | Why                                                                                   |
| ------------------------------------------------------------ | -------------------------- | ------------------------------------------------------------------------------------- |
| The three Next.js frontends (SSO, DMS, GMS)                  | **Vercel**                 | static assets and server rendering are what Vercel is good at                         |
| One small "portal" project                                   | **Vercel**                 | gives all three the standard paths on one address: `/sso`, `/dms`, `/gms`         |
| PostgreSQL 18 (three databases), Valkey, MinIO               | **this PC** (Docker)       | your requirement; bound to `127.0.0.1`, never exposed                                 |
| The three backends and the DMS worker                        | **this PC**                | see below                                                                             |
| nginx "entry" and the Cloudflare tunnel                      | **this PC**                | the only door from the internet: HTTPS out through the tunnel, no inbound port         |

**Why the backends are not on Vercel.** Vercel runs short-lived serverless functions. These backends
are long-running processes: WebSockets (Socket.IO), background workers (BullMQ queues, the outbox
poller, the identity provider's own timers), Redis connections, file uploads to object storage and
the OIDC provider's sessions. Moving them to functions would be a rewrite of three systems, not a
deployment. So the databases and the servers that need them stay together on this PC, and Vercel
serves what it can serve well. Nothing connects to the database from outside: the backends talk to
it over loopback.

```
 browser ──► Vercel "portal" (one address, rewrites by path)
              ├─ /sso /dms /gms          ──► the three frontends on Vercel
              └─ /api /socket.io /dms/api/v1 /gms/__sso
                 and the identity API        ──► tunnel ──► nginx entry (this PC) ──► backends ──► PostgreSQL, Valkey, MinIO
```

## What you need (only you can do these)

1. A Vercel account and a token (vercel.com/account/tokens). **Hobby plans are for non-commercial
   use**; a business needs Pro.
2. For a stable address: a domain on Cloudflare (free) and a named tunnel (below). For a trial you can
   use a `trycloudflare.com` address, which changes every time the tunnel restarts.
3. This PC awake and online while people use the site (see "Keeping it running").

## First time

```powershell
# 0. Set the paths once (these are this machine's; change them elsewhere)
$saas  = "C:\work\saas"   # holds sso-saas, dms-saas, gms-saas
$rt    = "C:\work\runtime\saas"                                                       # secrets and logs, never in git
$infra = "C:\work\meridian-infra"
$env:VERCEL_TOKEN = "<your token>"

# 1. Learn the public address Vercel gives the portal (creates the project, deploys a placeholder)
node $infra\vercel\deploy.mjs --saas-root $saas --runtime $rt --only-address

# 2. Start the tunnel that reaches this PC (pick one)
#    trial:  node $infra\hosting\scripts\stack.mjs up ... --tunnel quick      -> prints a https://....trycloudflare.com address in $rt\logs\tunnel.log
#    stable: see "A stable tunnel" below, then use --tunnel named --tunnel-name saas
$backend = "https://api.example.com"      # the tunnel address

# 3. Prepare this PC for that public address (data plane, env files, builds, migrations, first seed)
node $infra\hosting\scripts\prepare.mjs --saas-root $saas --runtime $rt --origin <address from step 1> --backend-origin $backend --frontends none
node $infra\hosting\nginx\render-entry.mjs --out $rt\nginx --frontends none
node $infra\hosting\scripts\stack.mjs up --saas-root $saas --runtime $rt --frontends none --tunnel named --tunnel-name saas

# 4. Deploy the frontends and the portal to Vercel
node $infra\vercel\deploy.mjs --saas-root $saas --runtime $rt --backend-origin $backend --origin <address from step 1>

# 5. Prove it in a real browser
node $infra\hosting\test\saas-flow.mjs --origin <address from step 1> --password <administrator password> --playwright-from "$saas\sso-saas\frontend"
```

`prepare.mjs` prints the first administrator's password once (`admin@examplecorp.com`); it is also in
`$rt\secrets.json`. Sign in and change it. The same password was set for the guest-system and
identity administrators; each system lets you change its own.

## A stable tunnel (recommended)

```powershell
cloudflared tunnel login                         # opens a browser; pick your domain
cloudflared tunnel create saas
cloudflared tunnel route dns saas api.example.com
# copy hosting\cloudflared\config.example.yml to %USERPROFILE%\.cloudflared\config.yml and put your tunnel id in it
```

A named tunnel keeps its address, so the Vercel build settings never go stale. With a
`trycloudflare.com` address, restarting the tunnel changes the address, and you must run steps 3 and 4
again (the address is built into the frontends and into the identity provider's registered clients).

## Everyday

| Do this                           | With                                                                                         |
| --------------------------------- | -------------------------------------------------------------------------------------------- |
| See what is running               | `node hosting\scripts\stack.mjs status --runtime $rt`                                        |
| Stop everything                   | `node hosting\scripts\stack.mjs down --runtime $rt`                                          |
| Restart one service               | `node hosting\scripts\stack.mjs restart sso-backend --saas-root $saas --runtime $rt`         |
| Apply database changes only       | `npm run db:migrate:prod` in `sso-saas\backend` (the admin console's System health page lists any not applied) |
| Read a log                        | `$rt\logs\<service>.log` (backends, worker, tunnel); nginx logs are in `$rt\nginx\logs`      |
| Deploy a new version of the code  | `git pull` in the three repos, then step 3 (rebuilds and migrates), then step 4              |
| Start at logon                    | `hosting\scripts\register-startup.ps1` (see the file for what it does and how to remove it)  |

## Keeping it running

The identity backend is started by `stack.mjs` through its own supervisor (`npm run start:prod:supervised`), which restarts the
process if it crashes or stops answering its health check. The admin console's System health page shows it as supervised; if that
page ever reports "This process is not supervised", the backend was started some other way, so restart it with
`stack.mjs restart sso-backend`.

This is a laptop. For people to use the site it must stay awake, plugged in and online:
`powercfg /change standby-timeout-ac 0`, the lid action set to "do nothing" on AC, Docker Desktop set to
start at sign-in, and Windows Update restarts scheduled outside the hours people use it. If it is off, the
frontends still load from Vercel but sign-in and every data call fail.

## Things to know

- **Real-time notifications use long polling.** Vercel does not carry WebSockets through rewrites, so
  Socket.IO stays on its polling transport. Everything works; updates arrive within a few seconds.
- **Large uploads.** The DMS uploads files in pieces, which fits. A single request larger than a few
  megabytes may be refused by Vercel's edge; if people report failed uploads, point the DMS frontend's
  API address straight at the tunnel instead of through Vercel (a CORS setting, `CORS_ORIGINS`).
- **Mail.** The editions are set to a placeholder mail server (`smtp.invalid`), so no mail is sent.
  Put a real relay in the two backend env files (`SMTP_*`) and run step 3 again.
- **The address check.** Rate limits and the identity provider's audit trail record the visitor's real
  address: Vercel passes it in `X-Forwarded-For` and the nginx entry hands it to the backends
  (loopback and private addresses in that header are ignored, so nobody can pose as this machine).
- **What is exposed.** Through the tunnel: only the routes in `hosting/nginx/render-entry.mjs`. The
  identity backend's internal, metrics and documentation routes are not routed. The databases,
  Valkey and MinIO listen on `127.0.0.1` only.
- **Backups.** The data lives in Docker volumes on this PC. Back it up before you rely on it:
  `docker compose exec postgres pg_dump -U postgres <db> > backup.sql` for each of `sso_saas`,
  `dms_saas`, `gms_saas`, and copy the MinIO volume. Keep `$rt\secrets.json` with the backups; without
  it encrypted documents cannot be read.

## What is not in git (needed to rebuild or move the host)

Git holds the code, scripts and this runbook. These live only on the host PC, by design, so a clone on another machine gets a
clean start and never a copy of the secrets:

| Item                                                   | Where                                       | Without it                                                                  |
| ------------------------------------------------------ | ------------------------------------------- | --------------------------------------------------------------------------- |
| Generated secrets and database password                | `$rt\secrets.json`, `$rt\infra.env`         | `prepare.mjs` makes new ones, but existing encrypted data cannot be read     |
| Owner verification key file                            | `$rt\owner-store.key`                       | the owner's answers and recovery codes cannot be checked; run `owner:recover` |
| The owner's recovery codes                             | on paper, with the owner                    | no fallback while email is unavailable                                       |
| The services' env files                                | each backend's `.env.production` (ignored)  | regenerated from the secrets by `make-env.mjs`                               |
| Database and object-storage data                       | Docker volumes on this PC                   | restore from the dumps described under "Backups"                             |
| Vercel project settings, tokens and the portal address | the Vercel account (`vercel login`)         | `deploy.mjs` recreates projects; tokens are issued again                     |
| The funnel address and its configuration               | Tailscale (`tailscale funnel status`)       | re-run the funnel set-up; update `DEMO_HEALTH_URL` on the `portfolio` project |
| Backups of earlier builds and databases                | `$rt\backups\`                              | no rollback point                                                            |

Another dev machine needs none of this to work on the code: clone the repositories (`workspace` lists them), run each app's
tests and its own local compose stack. Only a machine that is to become the host needs the table above.
