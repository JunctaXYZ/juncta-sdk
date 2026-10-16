#!/usr/bin/env node
// Fails when coverage-baseline.json is lower than on the base commit, or out
// of range. vitest enforces the baseline as its threshold, so lowering the
// file would quietly lower the bar; raising it is always allowed.
//
// Usage: node scripts/check-coverage-baseline.mjs BASE_REF
//   Run from the repository root. A base that does not resolve fails: a
//   check that cannot compare must not pass.
import { spawnSync } from 'node:child_process';
import console from 'node:console';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const FILE = 'coverage-baseline.json';
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
    if (!METRICS.includes(key)) throw new Error(`${source} has an unknown field ${key}`);
  }
  for (const metric of METRICS) {
    const n = value[metric];
    if (typeof n !== 'number' || !Number.isFinite(n) || n < FLOOR || n > 100) {
      throw new Error(`${source}: ${metric} must be a number from ${FLOOR} to 100`);
    }
  }
  return { lines: value.lines, branches: value.branches };
}

export function compareBaselines(base, head) {
  return METRICS.filter((m) => head[m] < base[m]).map(
    (m) => `${m} baseline fell from ${base[m]} to ${head[m]}`,
  );
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
    throw new Error(`${problems.join('; ')}. Raise coverage instead of lowering the baseline`);
  }
  console.log(`coverage baseline: ok (lines ${head.lines}, branches ${head.branches})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`coverage baseline: ${err.message}`);
    process.exit(1);
  }
}
