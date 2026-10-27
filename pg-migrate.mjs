#!/usr/bin/env node
// pg-migrate: interactive Postgres -> Postgres data migration.
// Zero dependencies. Needs pg_dump, pg_restore and psql on PATH.
// https://github.com/ym-scripts/pg-migrate
//
// Copyright (c) 2026 Aghogho Meyoron. MIT License.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, rm, stat, statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const VERSION = '0.2.0';

// ---------- CLI flags ----------
const args = process.argv.slice(2);
const KNOWN = ['dry-run', 'jobs', 'exclude-schema', 'keep-dump', 'yes', 'overwrite', 'version', 'help'];
for (const a of args) {
  const name = a === '-h' ? 'help' : a === '-y' ? 'yes' : a === '-v' ? 'version' : a.replace(/^--/, '').split('=')[0];
  if (!a.startsWith('-') || !KNOWN.includes(name)) {
    console.error(`Unknown option: ${a} (see pg-migrate --help)`);
    process.exit(2);
  }
}
const SHORT = { help: '-h', yes: '-y', version: '-v' };
const flag = (n) => args.includes(`--${n}`) || (SHORT[n] !== undefined && args.includes(SHORT[n]));
const opt = (n, d) => {
  const a = args.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split('=').slice(1).join('=') : d;
};
const excludeSchemas = args.filter((a) => a.startsWith('--exclude-schema=')).map((a) => a.split('=').slice(1).join('=')).filter(Boolean);
const JOBS = Math.max(1, parseInt(opt('jobs', '2'), 10) || 2);

if (flag('version')) {
  console.log(VERSION);
  process.exit(0);
}

if (flag('help')) {
  console.log(`pg-migrate: copy everything from one Postgres database to another.

Usage: pg-migrate [options]

  --dry-run                 Run all checks, then stop (changes nothing)
  --jobs=N                  Parallel restore jobs (default 2)
  --exclude-schema=NAME     Skip a schema (repeatable)
  --keep-dump               Keep the dump file after finishing
  -y, --yes                 Don't ask for confirmation (empty target only)
  --overwrite               With --yes, also allow overwriting a non-empty target
  -v, --version             Print the version
  -h, --help                Show this help

URLs are prompted for (input hidden). To skip the prompts set
SOURCE_URL and TARGET_URL in the environment.

Exit codes: 0 success, 1 checks/migration/verification failed, 2 usage error.`);
  process.exit(0);
}

// ---------- output helpers ----------
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = (s) => paint(32, s);
const red = (s) => paint(31, s);
const yellow = (s) => paint(33, s);
const dim = (s) => paint(2, s);
const bold = (s) => paint(1, s);
const cyan = (s) => paint(36, s);
const ICON = { pass: green('✔'), warn: yellow('▲'), fail: red('✖'), skip: dim('–') };

const fmtBytes = (n) => {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
};
const fmtSecs = (ms) => {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
};

// ---------- prompts ----------
function ask(q) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, (a) => { rl.close(); resolve(a.trim()); });
  });
}

function askHidden(q) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) { reject_nontty(); return; }
    process.stdout.write(q);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    const done = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write('\n');
      resolve(buf.trim());
    };
    const onData = (chunk) => {
      for (const ch of chunk.replace(/\x1b\[20[01]~/g, '')) {
        if (ch === '\r' || ch === '\n') return done();
        if (ch === '\u0003') { process.stdout.write('\n'); process.exit(130); }
        if (ch === '\u007f' || ch === '\b') {
          if (buf) { buf = buf.slice(0, -1); process.stdout.write('\b \b'); }
        } else if (ch >= ' ') {
          buf += ch;
          process.stdout.write('•');
        }
      }
    };
    stdin.on('data', onData);
  });
}
function reject_nontty() {
  console.error('No TTY for prompts. Set SOURCE_URL and TARGET_URL env vars instead.');
  process.exit(2);
}

// ---------- connection handling ----------
function parseUrl(raw) {
  const url = new URL(raw);
  if (!/^postgres(ql)?:$/.test(url.protocol)) throw new Error('URL must start with postgres:// or postgresql://');
  if (!url.hostname || !url.pathname.slice(1)) throw new Error('URL needs a host and a database name');
  return {
    host: url.hostname,
    port: url.port || '5432',
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    db: decodeURIComponent(url.pathname.slice(1)),
    sslmode: url.searchParams.get('sslmode'),
  };
}
const label = (c) => `${c.user}@${c.host}:${c.port}/${c.db}`;
const pgEnv = (c) => ({
  ...process.env,
  PGHOST: c.host,
  PGPORT: c.port,
  PGUSER: c.user,
  PGPASSWORD: c.password,
  PGDATABASE: c.db,
  PGSSLMODE: c.sslmode || 'prefer',
  PGCONNECT_TIMEOUT: '15',
  PGAPPNAME: 'pg-migrate',
});

function run(cmd, cmdArgs, env) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, cmdArgs, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('error', reject);
    p.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function psql(conn, sql) {
  const r = await run('psql', ['-X', '-A', '-t', '-q', '-F', '\t', '-v', 'ON_ERROR_STOP=1', '-c', sql], pgEnv(conn));
  if (r.code !== 0) throw new Error(r.stderr.trim().split('\n')[0] || `psql exited with ${r.code}`);
  return r.stdout.trim();
}
const rows = (s) => (s ? s.split('\n').map((l) => l.split('\t')) : []);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Schemas left out of every check and comparison: system schemas plus --exclude-schema.
const sqlLit = (v) => `'${v.replace(/'/g, "''")}'`;
const SYS = `(${['pg_catalog', 'information_schema', ...excludeSchemas].map(sqlLit).join(',')})`;
const USER_TABLES = `schemaname not in ${SYS}`;

// ---------- check runner ----------
const results = [];
async function check(name, fn) {
  let r;
  try {
    r = await fn();
  } catch (e) {
    r = { status: 'fail', msg: e.message.split('\n')[0] };
  }
  results.push({ name, ...r });
  console.log(`  ${ICON[r.status]} ${name}${r.msg ? dim(' — ') + r.msg : ''}`);
  return r.status !== 'fail';
}
const skip = (name, why) => {
  results.push({ name, status: 'skip' });
  console.log(`  ${ICON.skip} ${name}${dim(' — skipped: ' + why)}`);
};

// ---------- progress spinner ----------
async function withSpinner(text, fn, sizeFile) {
  const t0 = Date.now();
  if (!process.stdout.isTTY) { console.log(`  ${text}…`); return fn(); }
  const frames = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
  let i = 0;
  let size = '';
  const timer = setInterval(async () => {
    if (sizeFile) { try { size = ' · ' + fmtBytes((await stat(sizeFile)).size); } catch {} }
    process.stdout.write(`\r  ${cyan(frames[i++ % frames.length])} ${text} ${dim(fmtSecs(Date.now() - t0) + size)}   `);
  }, 200);
  try {
    return await fn();
  } finally {
    clearInterval(timer);
    process.stdout.write('\r\x1b[2K');
  }
}

// ---------- main ----------
let workDir;
const cleanup = async (keep) => { if (workDir && !keep) await rm(workDir, { recursive: true, force: true }); };
process.on('SIGINT', async () => { await cleanup(flag('keep-dump')); console.log('\nAborted.'); process.exit(130); });

async function main() {
  console.log(bold('\npg-migrate') + dim('  Postgres → Postgres\n'));

  // 1. Collect URLs
  let srcRaw = process.env.SOURCE_URL || (await askHidden('Current (source) database URL: '));
  let tgtRaw = process.env.TARGET_URL || (await askHidden('New (target) database URL:     '));
  let src, tgt;
  try { src = parseUrl(srcRaw); } catch (e) { fatal(`Source URL: ${e.message}`); }
  try { tgt = parseUrl(tgtRaw); } catch (e) { fatal(`Target URL: ${e.message}`); }
  srcRaw = tgtRaw = '';
  console.log(`\n  Source: ${bold(label(src))}\n  Target: ${bold(label(tgt))}\n`);

  // 2. Pre-flight checks
  console.log(bold('Pre-flight checks'));
  const ctx = { tgtTables: 0 };

  await check('PostgreSQL client tools installed', async () => {
    const v = {};
    for (const t of ['pg_dump', 'pg_restore', 'psql']) {
      try {
        v[t] = (await run(t, ['--version'], process.env)).stdout.trim().replace(/^.*\) /, '');
      } catch {
        throw new Error(`${t} not found on PATH. Install with: brew install libpq && brew link --force libpq`);
      }
    }
    ctx.client = parseInt(v.pg_dump, 10);
    ctx.toolsOk = true;
    return { status: 'pass', msg: `pg_dump ${v.pg_dump}` };
  });

  await check('Source and target are different databases', async () => {
    if (src.host === tgt.host && src.port === tgt.port && src.db === tgt.db) {
      throw new Error('Source and target point to the same database');
    }
    return { status: 'pass' };
  });

  await check('Source connection type', async () => {
    if (/pooler/i.test(src.host) || src.port === '6432') {
      return { status: 'warn', msg: 'looks like a pooled connection; use the direct connection or pg_dump may fail' };
    }
    return { status: 'pass', msg: 'direct connection' };
  });

  await check('Target uses SSL', async () => {
    const local = ['localhost', '127.0.0.1', '::1'].includes(tgt.host);
    if (!local && !['require', 'verify-ca', 'verify-full'].includes(tgt.sslmode)) {
      return { status: 'warn', msg: 'add ?sslmode=require to the target URL (Aiven requires SSL)' };
    }
    return { status: 'pass', msg: tgt.sslmode || 'local' };
  });

  const probe = async (conn) => {
    const r = rows(await psql(conn, `select current_setting('server_version_num')::int, current_setting('server_version'), current_setting('server_encoding'), (select datcollate from pg_database where datname=current_database()), pg_database_size(current_database())`))[0];
    return { major: Math.floor(parseInt(r[0], 10) / 10000), version: r[1], encoding: r[2], collate: r[3], size: Number(r[4]) };
  };

  ctx.srcOk = ctx.toolsOk && (await check('Source reachable and authenticated', async () => {
    ctx.src = await probe(src);
    return { status: 'pass', msg: `PostgreSQL ${ctx.src.version}, ${fmtBytes(ctx.src.size)}` };
  }));
  if (!ctx.toolsOk) skip('Source reachable and authenticated', 'tools missing');

  ctx.tgtOk = ctx.toolsOk && (await check('Target reachable and authenticated', async () => {
    ctx.tgt = await probe(tgt);
    return { status: 'pass', msg: `PostgreSQL ${ctx.tgt.version}` };
  }));
  if (!ctx.toolsOk) skip('Target reachable and authenticated', 'tools missing');

  if (ctx.srcOk && ctx.tgtOk) {
    await check('Version compatibility', async () => {
      if (ctx.client < ctx.src.major) throw new Error(`local pg_dump ${ctx.client} is older than source server ${ctx.src.major}; upgrade the client tools`);
      if (ctx.tgt.major < ctx.src.major) throw new Error(`target PG ${ctx.tgt.major} is older than source PG ${ctx.src.major}; create a newer target`);
      return { status: 'pass', msg: `client ${ctx.client}, source ${ctx.src.major}, target ${ctx.tgt.major}` };
    });

    await check('Encoding and collation', async () => {
      if (ctx.src.encoding !== ctx.tgt.encoding) throw new Error(`encoding differs (${ctx.src.encoding} vs ${ctx.tgt.encoding})`);
      if (ctx.src.collate !== ctx.tgt.collate) return { status: 'warn', msg: `collation differs (${ctx.src.collate} vs ${ctx.tgt.collate}); text indexes/sorting may change` };
      return { status: 'pass', msg: `${ctx.src.encoding}, ${ctx.src.collate}` };
    });

    await check('Extensions available on target', async () => {
      const used = rows(await psql(src, `select extname from pg_extension where extname <> 'plpgsql' order by 1`)).map((r) => r[0]);
      if (!used.length) return { status: 'pass', msg: 'none in use' };
      const avail = new Set(rows(await psql(tgt, `select name from pg_available_extensions`)).map((r) => r[0]));
      const missing = used.filter((e) => !avail.has(e));
      if (missing.length) throw new Error(`not available on target: ${missing.join(', ')}`);
      return { status: 'pass', msg: used.join(', ') };
    });

    await check('Target permissions', async () => {
      const [db, sch] = rows(await psql(tgt, `select has_database_privilege(current_user, current_database(), 'CREATE'), has_schema_privilege(current_user, 'public', 'CREATE')`))[0];
      if (db !== 't') throw new Error('user lacks CREATE on the target database');
      if (sch !== 't') return { status: 'warn', msg: 'user cannot create in schema public' };
      return { status: 'pass', msg: 'can create objects' };
    });

    await check('Target is empty', async () => {
      ctx.tgtTables = parseInt(await psql(tgt, `select count(*) from pg_tables where ${USER_TABLES}`), 10);
      if (ctx.tgtTables > 0) return { status: 'warn', msg: `${ctx.tgtTables} existing tables will be OVERWRITTEN` };
      return { status: 'pass', msg: 'no user tables' };
    });

    await check('Source tables readable', async () => {
      const n = parseInt(await psql(src, `select count(*) from pg_tables where ${USER_TABLES} and not has_table_privilege(format('%I.%I', schemaname, tablename), 'SELECT')`), 10);
      if (n > 0) throw new Error(`${n} tables the source user cannot SELECT from`);
      ctx.srcTables = parseInt(await psql(src, `select count(*) from pg_tables where ${USER_TABLES}`), 10);
      return { status: 'pass', msg: `${ctx.srcTables} tables` };
    });

    await check('Disk space for dump', async () => {
      const fs = await statfs(tmpdir());
      const free = fs.bavail * fs.bsize;
      if (free < ctx.src.size * 0.25) throw new Error(`only ${fmtBytes(free)} free in ${tmpdir()}, DB is ${fmtBytes(ctx.src.size)}`);
      if (free < ctx.src.size) return { status: 'warn', msg: `${fmtBytes(free)} free; dump is compressed but this is tight` };
      return { status: 'pass', msg: `${fmtBytes(free)} free` };
    });

    await check('No writes to source right now', async () => {
      const q = `select coalesce(tup_inserted + tup_updated + tup_deleted, 0) from pg_stat_database where datname = current_database()`;
      const a = BigInt(await psql(src, q));
      await sleep(4000);
      const b = BigInt(await psql(src, q));
      if (b !== a) return { status: 'warn', msg: `${b - a} row changes in 4s; stop the app (maintenance mode) for a consistent copy` };
      return { status: 'pass', msg: 'idle for 4s' };
    });
  } else {
    for (const n of ['Version compatibility', 'Encoding and collation', 'Extensions available on target', 'Target permissions', 'Target is empty', 'Source tables readable', 'Disk space for dump', 'No writes to source right now']) {
      skip(n, 'needs both connections');
    }
  }

  // 3. Summary
  const fails = results.filter((r) => r.status === 'fail');
  const warns = results.filter((r) => r.status === 'warn');
  const passes = results.filter((r) => r.status === 'pass');
  console.log(`\n  ${green(passes.length + ' passed')}  ${warns.length ? yellow(warns.length + ' warnings') : dim('0 warnings')}  ${fails.length ? red(fails.length + ' failed') : dim('0 failed')}\n`);

  if (fails.length) {
    console.log(red('Not ready. Fix the failed checks and run again. Nothing was changed.\n'));
    process.exit(1);
  }
  if (flag('dry-run')) {
    console.log('Dry run complete. Nothing was changed.\n');
    process.exit(0);
  }

  // 4. Final confirmation
  console.log(bold('Plan'));
  console.log(`  Copy ${bold(ctx.srcTables + ' tables')} (${fmtBytes(ctx.src.size)}) from ${bold(label(src))}`);
  console.log(`  into ${bold(label(tgt))}`);
  console.log(dim('  Source is only read. Target objects with the same names are dropped and recreated.\n'));
  if (warns.length) {
    console.log(yellow('Warnings:'));
    for (const w of warns) console.log(`  ${ICON.warn} ${w.name}: ${w.msg}`);
    console.log('');
  }
  if (flag('yes')) {
    if (ctx.tgtTables > 0 && !flag('overwrite')) {
      console.log(red('Target is not empty. Pass --overwrite together with --yes to replace its data. Nothing was changed.\n'));
      process.exit(1);
    }
    console.log(dim('--yes given, starting without a prompt.'));
  } else if (ctx.tgtTables > 0) {
    const typed = await ask(`Target already has data that WILL BE OVERWRITTEN. Type the target database name (${tgt.db}) to start: `);
    if (typed !== tgt.db) { console.log('Cancelled. Nothing was changed.'); process.exit(1); }
  } else {
    const yn = await ask('All checks passed. Start the migration? [y/N] ');
    if (!/^y(es)?$/i.test(yn)) { console.log('Cancelled. Nothing was changed.'); process.exit(1); }
  }

  // 5. Migrate
  const t0 = Date.now();
  workDir = await mkdtemp(join(tmpdir(), 'pg-migrate-'));
  const dump = join(workDir, 'source.dump');
  let keep = flag('keep-dump');
  let failed = false;

  try {
    console.log(bold('\nMigrating'));

    const countsSql = `select format('%I.%I', schemaname, tablename), (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', schemaname, tablename), false, true, '')))[1]::text from pg_tables where ${USER_TABLES} order by 1`;
    const toMap = (s) => new Map(rows(s));

    const baseline = toMap(await withSpinner('Counting source rows', () => psql(src, countsSql)));
    console.log(`  ${ICON.pass} Counted rows in ${baseline.size} source tables`);

    const dumpArgs = ['-Fc', '--no-owner', '--no-privileges', ...excludeSchemas.flatMap((s) => ['--exclude-schema', s]), '-f', dump];
    const d = await withSpinner('Dumping source', () => run('pg_dump', dumpArgs, pgEnv(src)), dump);
    if (d.code !== 0) { keep = false; throw new Error('pg_dump failed:\n' + d.stderr.trim()); }
    console.log(`  ${ICON.pass} Dumped source ${dim(fmtBytes((await stat(dump)).size))}`);

    const r = await withSpinner('Restoring into target', () =>
      run('pg_restore', ['-d', tgt.db, '--no-owner', '--no-privileges', '--clean', '--if-exists', '-j', String(JOBS), dump], pgEnv(tgt)));
    const errs = [...new Set(r.stderr.split('\n').filter((l) => /error/i.test(l)))];
    if (r.code !== 0 || errs.length) {
      console.log(`  ${ICON.warn} Restore finished with ${errs.length} error line(s)${dim(' (often harmless ownership/role notices; verification decides)')}`);
      for (const e of errs.slice(0, 10)) console.log(dim('      ' + e.slice(0, 200)));
      if (errs.length > 10) console.log(dim(`      …and ${errs.length - 10} more`));
    } else {
      console.log(`  ${ICON.pass} Restored into target`);
    }

    // 6. Verify
    console.log(bold('\nVerifying'));
    const targetCounts = toMap(await psql(tgt, countsSql));
    let bad = 0;
    const w = Math.max(5, ...[...baseline.keys()].map((k) => k.length));
    console.log(dim(`  ${'TABLE'.padEnd(w)}  ${'SOURCE'.padStart(12)}  ${'TARGET'.padStart(12)}`));
    for (const [t, n] of baseline) {
      const a = targetCounts.get(t) ?? 'MISSING';
      const ok = a === n;
      if (!ok) bad++;
      console.log(`  ${ok ? ICON.pass : ICON.fail} ${t.padEnd(w)}  ${n.padStart(12)}  ${String(a).padStart(12)}${ok ? '' : red('  mismatch')}`);
    }
    const extra = [...targetCounts.keys()].filter((t) => !baseline.has(t));
    if (extra.length) console.log(dim(`  (target has ${extra.length} extra table(s) not in source: ${extra.join(', ')})`));

    const seqSql = `select format('%I.%I', schemaname, sequencename), coalesce(last_value::text, 'unused') from pg_sequences where ${USER_TABLES} order by 1`;
    const sa = toMap(await psql(src, seqSql));
    const sb = toMap(await psql(tgt, seqSql));
    let seqBad = 0;
    for (const [k, v] of sa) if (sb.get(k) !== v) seqBad++;
    console.log(`  ${seqBad ? ICON.fail : ICON.pass} Sequences: ${sa.size} checked${seqBad ? red(`, ${seqBad} differ`) : ''}`);
    bad += seqBad;

    const structSql = `
      select 'tables', count(*) from pg_tables where ${USER_TABLES}
      union all select 'indexes', count(*) from pg_indexes where ${USER_TABLES}
      union all select 'views', count(*) from pg_views where ${USER_TABLES}
      union all select 'constraints', count(*) from pg_constraint c join pg_namespace n on n.oid = c.connamespace where n.nspname not in ${SYS} and c.contype in ('p','f','u','c')
      union all select 'triggers', count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where not t.tgisinternal and n.nspname not in ${SYS}
      union all select 'functions', count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname not in ${SYS} and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')`;
    const ma = toMap(await psql(src, structSql));
    const mb = toMap(await psql(tgt, structSql));
    const diffs = [...ma].filter(([k, v]) => mb.get(k) !== v);
    if (diffs.length) {
      console.log(`  ${ICON.warn} Structure differs: ${diffs.map(([k, v]) => `${k} ${v}→${mb.get(k)}`).join(', ')}`);
    } else {
      console.log(`  ${ICON.pass} Structure: ${[...ma].map(([k, v]) => `${v} ${k}`).join(', ')}`);
    }

    if (bad) {
      failed = true;
      keep = true;
      console.log(red(`\n✖ Verification FAILED (${bad} problem${bad > 1 ? 's' : ''}).`) + ' If the source received writes during the run, re-run with writes stopped.');
      console.log(`  Dump kept at ${dump}`);
    } else {
      console.log(green(`\n✔ Migration complete and verified in ${fmtSecs(Date.now() - t0)}.`));
      console.log(dim('  Next: point your app at the new DATABASE_URL, redeploy, smoke test, keep the old DB for a few days as a rollback.'));
    }
  } catch (e) {
    failed = true;
    console.log(red('\n✖ ' + e.message));
  } finally {
    await cleanup(keep);
  }
  process.exit(failed ? 1 : 0);
}

function fatal(msg) {
  console.error(red(msg));
  process.exit(2);
}

main().catch((e) => { console.error(red(e.stack || e.message)); process.exit(1); });
