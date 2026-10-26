#!/bin/sh
# Runs once, on the first start of an empty data directory. One database per system, and the
# least-privilege application role DMS connects as (its migrations run as the superuser and grant
# what the role needs; row-level security is forced for it).
set -eu

: "${EDAMS_APP_DB_PASSWORD:?EDAMS_APP_DB_PASSWORD must be set}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<-EOSQL
	SELECT 'CREATE DATABASE sso_saas' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'sso_saas')\gexec
	SELECT 'CREATE DATABASE dms_saas' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'dms_saas')\gexec
	SELECT 'CREATE DATABASE gms_saas' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'gms_saas')\gexec
	DO \$\$
	BEGIN
	  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'edams_app') THEN
	    CREATE ROLE edams_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE
	      PASSWORD '$(printf %s "$EDAMS_APP_DB_PASSWORD" | sed "s/'/''/g")';
	  END IF;
	END
	\$\$;
	GRANT CONNECT ON DATABASE dms_saas TO edams_app;
EOSQL

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname dms_saas <<-EOSQL
	GRANT USAGE ON SCHEMA public TO edams_app;
EOSQL

echo "databases sso_saas, dms_saas, gms_saas and role edams_app ready"
