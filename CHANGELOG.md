# Changelog

All notable changes to this project are documented here. This project follows [Semantic Versioning](https://semver.org).

## [0.2.0] - 2026-10-27

### Added
- `-y/--yes` to run without prompts, and `--overwrite` to allow replacing a non-empty target when using `--yes`.
- `-v/--version`, and the short flags `-h` and `-y`.
- Unknown options are rejected with exit code 2.
- Runs straight from GitHub: `npx github:ym-scripts/pg-migrate`.
- CI: lint on Node 18/20/22 and an end-to-end migration test on PostgreSQL 15/16/17.

### Fixed
- `--exclude-schema` no longer causes false verification failures. Excluded schemas are now left out of row counts, sequence checks and structure checks.
- `--exclude-schema=a=b` keeps everything after the first `=`.

## [0.1.0] - 2026-10-01

### Added
- First release: pre-flight checks, `pg_dump`/`pg_restore` copy, and verification of row counts, sequences and object counts.
