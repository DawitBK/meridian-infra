# meridian-infra

> **Superseded for running the demo platform (2026-10-24).** The platform now runs entirely in Docker from its own repository
> ([`DawitBK/saas-platform`](https://github.com/DawitBK/saas-platform)): one compose file for the three systems, the four apps and the database, cache and file storage,
> with restart policies, health checks, backups and a runbook. The process supervisor and native-stack scripts in `hosting/` below
> are the earlier setup, kept as a reference and for the Cloudflare and Vercel templates; do not start the demo from them.

Hosting for the neutral SaaS editions (`sso-saas`, `dms-saas`, `gms-saas`): the frontends on Vercel, the databases
and backends on one machine you own, reached through a Cloudflare tunnel. Templates and scripts only; no secrets.

- `hosting/` - data plane (PostgreSQL 18, Valkey, MinIO), env generator, nginx entry, process supervisor, acceptance test
- `vercel/deploy.mjs` - creates the Vercel projects with the right build settings and environment, deploys them
- `docs/saas-on-vercel.md` - what runs where, and the exact steps

Start with `docs/saas-on-vercel.md`. Licence: Apache-2.0.
