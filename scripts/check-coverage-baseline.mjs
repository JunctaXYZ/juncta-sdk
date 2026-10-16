#!/usr/bin/env node
// Enforces the coverage bar independently of the vitest config:
// - measured coverage in coverage/coverage-summary.json is at least
//   max(85, baseline) for lines and branches, so zeroing vitest's
//   thresholds does not let a drop through;
// - coverage-baseline.json is in range and not lower than on the base
//   commit. Raising it is always allowed; lowering it fails here and needs
//   a reviewed change that edits this check's inputs on purpose.
//
// Usage: node scripts/check-coverage-baseline.mjs BASE_REF
//   Run from the repository root after vitest run --coverage. A base that
//   does not resolve, or a missing summary, fails: a check that cannot
//   compare must not pass.
import { spawnSync } from 'node:child_process';
import console from 'node:console';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const FILE = 'coverage-baseline.json';
const SUMMARY = 'coverage/coverage-summary.json';
const FLOOR = 85;
const METRICS = ['lines', 'branches'];

export function parseBaseline(text, source) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new Error(`${source} is not JSON: ${err.message}`, { cause: err });
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${source} must be an object with ${METRICS.join(' and ')}`);
  }
  for (const key of Object.keys(value)) {
    if (!METRICS.includes(key) && key !== 'reason') {
      throw new Error(`${source} has an unknown field ${key}`);
    }
  }
  if ('reason' in value && (typeof value.reason !== 'string' || value.reason.trim() === '')) {
    throw new Error(`${source}: reason must be a non-empty string`);
  }
  for (const metric of METRICS) {
    const n = value[metric];
    if (typeof n !== 'number' || !Number.isFinite(n) || n < FLOOR || n > 100) {
      throw new Error(`${source}: ${metric} must be a number from ${FLOOR} to 100`);
    }
  }
  const out = { lines: value.lines, branches: value.branches };
  if ('reason' in value) out.reason = value.reason;
  return out;
}

// Lowering the baseline is allowed only on purpose: the same change writes
// a reason into the file that the base did not have, and the file is under
// security review. The 85 percent floor holds regardless.
export function compareBaselines(base, head) {
  const fell = METRICS.filter((m) => head[m] < base[m]).map(
    (m) => `${m} baseline fell from ${base[m]} to ${head[m]}`,
  );
  if (fell.length === 0) return [];
  if (head.reason !== undefined && head.reason !== base.reason) return [];
  return [
    `${fell.join(', ')}; raise coverage instead, or set a new reason in ${FILE} to lower it on purpose`,
  ];
}

// coverage/coverage-summary.json from vitest's json-summary reporter. Only
// the totals are read, and only the raw counts: the pct field is rounded.
export function parseSummary(text, source) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new Error(`${source} is not JSON: ${err.message}`, { cause: err });
  }
  const total = value?.total;
  if (total === null || typeof total !== 'object') {
    throw new Error(`${source} has no total`);
  }
  const out = {};
  for (const metric of METRICS) {
    const m = total[metric];
    const valid =
      m !== null &&
      typeof m === 'object' &&
      Number.isInteger(m.total) &&
      Number.isInteger(m.covered) &&
      m.total >= 0 &&
      m.covered >= 0 &&
      m.covered <= m.total;
    if (!valid)
      throw new Error(`${source}: total.${metric} must hold whole counts, covered <= total`);
    out[metric] = { total: m.total, covered: m.covered };
  }
  return out;
}

// The floor and the baseline are enforced here as well as in vitest's
// thresholds, so weakening the vitest config does not lower the bar.
export function checkMeasured(summary, baseline) {
  const problems = [];
  for (const metric of METRICS) {
    const required = Math.max(FLOOR, baseline[metric]);
    const { total, covered } = summary[metric];
    // Nothing to cover is fully covered.
    if (total === 0) continue;
    const pct = (covered / total) * 100;
    if (pct < required) {
      const shown = Math.floor(pct * 100) / 100;
      problems.push(`${metric} coverage is ${shown} percent, below the required ${required}`);
    }
  }
  return problems;
}

function git(...args) {
  return spawnSync('git', args, { encoding: 'utf8' });
}

function main(argv) {
  if (argv.length !== 1) {
    throw new Error('usage: check-coverage-baseline.mjs BASE_REF');
  }
  const [baseRef] = argv;
  const resolved = git('rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`);
  if (baseRef === '' || resolved.status !== 0) {
    throw new Error(`cannot resolve base ${JSON.stringify(baseRef)}; fetch it or pass a commit`);
  }
  const base = resolved.stdout.trim();

  let headText;
  try {
    headText = readFileSync(FILE, 'utf8');
  } catch (err) {
    throw new Error(`cannot read ${FILE}: ${err.message}`, { cause: err });
  }
  const head = parseBaseline(headText, FILE);

  let summaryText;
  try {
    summaryText = readFileSync(SUMMARY, 'utf8');
  } catch (err) {
    throw new Error(`cannot read ${SUMMARY} (run vitest run --coverage first): ${err.message}`, {
      cause: err,
    });
  }
  const measured = checkMeasured(parseSummary(summaryText, SUMMARY), head);
  if (measured.length > 0) {
    throw new Error(`${measured.join('; ')}. Add tests for the uncovered code`);
  }

  // ls-tree prints nothing for a path the commit does not have, and fails
  // on a git error, so "absent" and "could not tell" stay distinct.
  const listed = git('ls-tree', '--name-only', base, '--', FILE);
  if (listed.status !== 0) {
    throw new Error(`cannot list ${FILE} at ${base}: ${listed.stderr.trim()}`);
  }
  if (listed.stdout.trim() === '') {
    console.log(`coverage baseline: no baseline at ${baseRef}; ${FILE} starts the ratchet`);
    return;
  }
  const shown = git('show', `${base}:${FILE}`);
  if (shown.status !== 0) {
    throw new Error(`cannot read ${FILE} at ${base}: ${shown.stderr.trim()}`);
  }
  const problems = compareBaselines(parseBaseline(shown.stdout, `${baseRef}:${FILE}`), head);
  if (problems.length > 0) {
    throw new Error(problems.join('; '));
  }
  if (head.reason !== undefined) console.log(`coverage baseline: reason given: ${head.reason}`);
  console.log(
    `coverage baseline: ok (measured coverage meets the floor; baseline lines ${head.lines}, branches ${head.branches})`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`coverage baseline: ${err.message}`);
    process.exit(1);
  }
}
