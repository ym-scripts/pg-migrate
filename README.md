# pg-migrate

[![CI](https://github.com/ym-scripts/pg-migrate/actions/workflows/ci.yml/badge.svg)](https://github.com/ym-scripts/pg-migrate/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Copy one Postgres database into another safely**, for example when moving from Neon to Aiven, Supabase to RDS, or local to managed. It runs pre-flight checks first, shows you a plan, copies with `pg_dump`/`pg_restore`, then verifies the result table by table.

No npm dependencies. Your connection strings are entered as hidden input and never printed.

```bash
npx github:ym-scripts/pg-migrate
```

## Requirements

- **Node.js 18.15+**
- **PostgreSQL client tools** (`pg_dump`, `pg_restore`, `psql`), with a major version **at least as new as the source server**:

  | OS | Install |
  | --- | --- |
  | macOS | `brew install libpq && brew link --force libpq` |
  | Debian/Ubuntu | `sudo apt install postgresql-client` (use the [PGDG repo](https://wiki.postgresql.org/wiki/Apt) for newer versions) |
  | Windows | [EDB installer](https://www.postgresql.org/download/windows/), command-line tools only |

## Usage

```bash
npx github:ym-scripts/pg-migrate                 # interactive
npx github:ym-scripts/pg-migrate --dry-run       # checks only, changes nothing
npx github:ym-scripts/pg-migrate#v0.2.0          # pin a version
```

You'll be asked for the **source** (current) and **target** (new) database URLs. After the checks you'll see a plan and must confirm before anything is copied. If the target already has tables, you must type its database name to continue.

### Options

| Option | Description |
| --- | --- |
| `--dry-run` | Run every check, then stop. Changes nothing. |
| `--jobs=N` | Parallel `pg_restore` jobs (default `2`). |
| `--exclude-schema=NAME` | Skip a schema. Repeatable. |
| `--keep-dump` | Keep the dump file afterwards. It's always kept if verification fails. |
| `-y`, `--yes` | Don't prompt. Only allowed when the target is empty, unless you also pass `--overwrite`. |
| `--overwrite` | Together with `--yes`, allow replacing data in a non-empty target. |
| `-v`, `--version` | Print the version. |
| `-h`, `--help` | Show help. |

### Non-interactive (CI, scripts)

```bash
SOURCE_URL='postgres://user:pass@old-host:5432/app?sslmode=require' \
TARGET_URL='postgres://user:pass@new-host:5432/app?sslmode=require' \
npx github:ym-scripts/pg-migrate --yes
```

Avoid putting URLs directly in shell history. Prefer a `.env` file you `source`, or your CI's secret store.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Migration completed and verified, or dry run passed |
| `1` | A check failed, the user cancelled, or verification found differences |
| `2` | Usage error (bad URL, unknown option, no TTY for prompts) |

## What it checks before copying

| Check | Fails / warns when |
| --- | --- |
| Client tools installed | `pg_dump`, `pg_restore` or `psql` is missing |
| Source ≠ target | Both URLs point at the same database |
| Source connection type | The source looks like a pooler (PgBouncer, port 6432), which can break `pg_dump` |
| Target SSL | A remote target has no `sslmode=require` |
| Connectivity | Either database can't be reached or authenticated |
| Version compatibility | Local `pg_dump` or the target server is older than the source |
| Encoding / collation | Encodings differ (fail) or collations differ (warn) |
| Extensions | An extension used by the source isn't available on the target |
| Target permissions | The target user can't create objects |
| Target is empty | Existing tables would be overwritten (warn and require confirmation) |
| Source tables readable | The source user can't `SELECT` some tables |
| Disk space | Too little free space in the temp dir for the dump |
| No live writes | Rows changed on the source during a 4-second sample |

## How it copies and verifies

1. Counts rows in every source table (exact `count(*)`).
2. `pg_dump -Fc --no-owner --no-privileges` to a temp file.
3. `pg_restore --clean --if-exists --no-owner --no-privileges -j N` into the target.
4. Compares the following between source and target:
   - exact row counts per table
   - sequence values
   - counts of tables, indexes, views, constraints, triggers and functions

The source is only ever read. The temp dump is deleted unless you pass `--keep-dump` or verification fails.

## Tips

- Use the **direct** connection string for the source, not the pooled one.
- **Stop writes** (maintenance mode) before migrating, or the copy won't be consistent.
- Roles and grants aren't copied (`--no-owner --no-privileges`). Objects are owned by the target user.
- Keep the old database for a few days after switching, so you can roll back.

## Development

```bash
node pg-migrate.mjs --help
SOURCE_URL=... TARGET_URL=... npm test   # e2e test, needs two empty disposable databases
```

## License

[MIT](LICENSE) © Aghogho Meyoron
