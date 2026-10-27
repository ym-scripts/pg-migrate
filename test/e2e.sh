#!/usr/bin/env bash
# End-to-end test against two real Postgres servers.
# Needs SOURCE_URL and TARGET_URL pointing at empty, disposable databases.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${SOURCE_URL:?set SOURCE_URL}" "${TARGET_URL:?set TARGET_URL}"
export SOURCE_URL TARGET_URL
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

step "seed source"
psql -X -q -v ON_ERROR_STOP=1 "$SOURCE_URL" <<'SQL'
create schema app;
create table app.users (id serial primary key, email text unique not null);
insert into app.users (email) select 'u' || g || '@example.com' from generate_series(1, 500) g;
create table public.notes (id bigserial primary key, user_id int references app.users(id), body text);
insert into public.notes (user_id, body) select (g % 500) + 1, md5(g::text) from generate_series(1, 2000) g;
create view app.user_note_counts as select user_id, count(*) from public.notes group by 1;
create schema scratch;
create table scratch.junk (id int);
SQL

step "dry run changes nothing"
node pg-migrate.mjs --dry-run
[ "$(psql -X -At "$TARGET_URL" -c "select count(*) from pg_tables where schemaname not in ('pg_catalog','information_schema')")" = 0 ]

step "migrate into empty target (excluding a schema)"
node pg-migrate.mjs --yes --exclude-schema=scratch
[ "$(psql -X -At "$TARGET_URL" -c 'select count(*) from public.notes')" = 2000 ]
[ "$(psql -X -At "$TARGET_URL" -c "select count(*) from pg_namespace where nspname = 'scratch'")" = 0 ]

step "non-empty target is refused without --overwrite"
if node pg-migrate.mjs --yes --exclude-schema=scratch; then echo "expected refusal" >&2; exit 1; fi

step "non-empty target with --overwrite"
node pg-migrate.mjs --yes --overwrite --exclude-schema=scratch

step "usage errors exit 2"
set +e; node pg-migrate.mjs --nope; code=$?; set -e
[ "$code" = 2 ]

printf '\n\033[32mAll e2e tests passed.\033[0m\n'
