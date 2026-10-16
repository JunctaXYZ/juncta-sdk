// Run with: node --test scripts/tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';
import {
  checkMeasured,
  compareBaselines,
  parseBaseline,
  parseSummary,
} from '../check-coverage-baseline.mjs';

const script = fileURLToPath(new URL('../check-coverage-baseline.mjs', import.meta.url));
const root = fileURLToPath(new URL('../..', import.meta.url));

// A coverage-summary.json as vitest writes it, reduced to what is read.
function summaryText(lines, branches) {
  const metric = ([covered, total]) => ({ total, covered, skipped: 0, pct: 0 });
  return JSON.stringify({ total: { lines: metric(lines), branches: metric(branches) } });
}

test('measured coverage at or above the floor and the baseline passes', () => {
  const s = parseSummary(summaryText([90, 100], [17, 20]), 'x');
  assert.deepEqual(checkMeasured(s, { lines: 85, branches: 85 }), []);
  assert.deepEqual(checkMeasured(s, { lines: 90, branches: 85 }), []);
});

test('measured coverage below the baseline fails per metric', () => {
  const s = parseSummary(summaryText([90, 100], [17, 20]), 'x');
  assert.deepEqual(checkMeasured(s, { lines: 91, branches: 86 }), [
    'lines coverage is 90 percent, below the required 91',
    'branches coverage is 85 percent, below the required 86',
  ]);
});

test('the 85 percent floor holds whatever the baseline says', () => {
  // As if the baseline file had been edited past its own validation.
  const s = parseSummary(summaryText([1, 3], [0, 2]), 'x');
  assert.deepEqual(checkMeasured(s, { lines: 0, branches: 0 }), [
    'lines coverage is 33.33 percent, below the required 85',
    'branches coverage is 0 percent, below the required 85',
  ]);
});

test('a metric with nothing to cover counts as covered', () => {
  const s = parseSummary(summaryText([1, 1], [0, 0]), 'x');
  assert.deepEqual(checkMeasured(s, { lines: 100, branches: 100 }), []);
});

test('the counts are used, not the rounded pct field', () => {
  // 849 of 1000 rounds to 85 in a two digit pct; it is still below 85.
  const s = parseSummary(summaryText([849, 1000], [1, 1]), 'x');
  assert.equal(checkMeasured(s, { lines: 85, branches: 85 }).length, 1);
});

test('a malformed coverage summary is refused', () => {
  assert.throws(() => parseSummary('not json', 'coverage/coverage-summary.json'), /not JSON/);
  assert.throws(() => parseSummary('{}', 's'), /total/);
  assert.throws(
    () => parseSummary('{"total": {"lines": {"total": 1, "covered": 1}}}', 's'),
    /branches/,
  );
  assert.throws(
    () => parseSummary(summaryText([2, 1], [0, 0]), 's'),
    /lines/,
    'more covered than total',
  );
  assert.throws(
    () =>
      parseSummary(
        '{"total": {"lines": {"total": "1", "covered": 1}, "branches": {"total": 0, "covered": 0}}}',
        's',
      ),
    /lines/,
  );
});

test('a well formed baseline parses', () => {
  assert.deepEqual(parseBaseline('{"lines": 92.5, "branches": 88}', 'x'), {
    lines: 92.5,
    branches: 88,
  });
});

test('a baseline under the 85 percent floor is refused', () => {
  assert.throws(() => parseBaseline('{"lines": 84.9, "branches": 90}', 'x'), /lines/);
});

test('a baseline over 100 percent is refused', () => {
  assert.throws(() => parseBaseline('{"lines": 90, "branches": 100.1}', 'x'), /branches/);
});

test('a missing, non-numeric or extra field is refused', () => {
  assert.throws(() => parseBaseline('{"lines": 90}', 'x'), /branches/);
  assert.throws(() => parseBaseline('{"lines": "90", "branches": 90}', 'x'), /lines/);
  assert.throws(
    () => parseBaseline('{"lines": 90, "branches": 90, "functions": 1}', 'x'),
    /functions/,
  );
});

test('text that is not JSON is refused with the file named', () => {
  assert.throws(() => parseBaseline('lines: 90', 'base:coverage-baseline.json'), /base:coverage/);
});

test('a reason may accompany the baseline', () => {
  assert.deepEqual(parseBaseline('{"lines": 90, "branches": 88, "reason": "moved code"}', 'x'), {
    lines: 90,
    branches: 88,
    reason: 'moved code',
  });
  assert.throws(() => parseBaseline('{"lines": 90, "branches": 88, "reason": ""}', 'x'), /reason/);
  assert.throws(() => parseBaseline('{"lines": 90, "branches": 88, "reason": 3}', 'x'), /reason/);
});

test('lowering the baseline needs a new reason in the same change', () => {
  const base = { lines: 95, branches: 90 };
  const lowered = { lines: 90, branches: 90 };
  assert.equal(compareBaselines(base, lowered).length, 1);
  assert.match(compareBaselines(base, lowered)[0], /set a new reason/);
  assert.deepEqual(compareBaselines(base, { ...lowered, reason: 'split the decoder' }), []);
  // A reason already on the base was spent on an earlier lowering.
  const reasoned = { ...base, reason: 'split the decoder' };
  assert.equal(compareBaselines(reasoned, { ...lowered, reason: 'split the decoder' }).length, 1);
  assert.deepEqual(compareBaselines(reasoned, { ...lowered, reason: 'dropped dead code' }), []);
});

test('a lower baseline than the base is reported per metric', () => {
  const base = { lines: 95, branches: 90 };
  assert.deepEqual(compareBaselines(base, { lines: 95, branches: 90 }), []);
  assert.deepEqual(compareBaselines(base, { lines: 96, branches: 91 }), []);
  assert.match(
    compareBaselines(base, { lines: 94, branches: 90 })[0],
    /^lines baseline fell from 95 to 94;/,
  );
  assert.match(
    compareBaselines(base, { lines: 94, branches: 89 })[0],
    /^lines baseline fell from 95 to 94, branches baseline fell from 90 to 89;/,
  );
});

// The scratch repositories must never touch the repository the tests run
// from, even under a git hook that exports GIT_DIR and friends.
function cleanEnv() {
  const names = new Set(
    execFileSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8' }).split('\n'),
  );
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !names.has(k)));
  return { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
}

function scratchRepo(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'coverage-baseline-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { ...cleanEnv(), GIT_CEILING_DIRECTORIES: dir };
  const git = (...args) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { cwd: dir, env, encoding: 'utf8' },
    ).trim();
  git('init', '-q', '-b', 'main');
  assert.equal(git('rev-parse', '--absolute-git-dir'), join(dir, '.git'));
  const run = (...args) =>
    spawnSync(process.execPath, [script, ...args], { cwd: dir, env, encoding: 'utf8' });
  const write = (text) => writeFileSync(join(dir, 'coverage-baseline.json'), text);
  const summary = (lines, branches) => {
    mkdirSync(join(dir, 'coverage'), { recursive: true });
    writeFileSync(join(dir, 'coverage', 'coverage-summary.json'), summaryText(lines, branches));
  };
  summary([10, 10], [4, 4]);
  return { dir, env, git, run, write, summary };
}

test('measured coverage under the baseline fails even when the baseline holds', (t) => {
  const repo = scratchRepo(t);
  repo.write('{"lines": 90, "branches": 88}');
  repo.git('add', '.');
  repo.git('commit', '-q', '-m', 'base');
  repo.summary([89, 100], [88, 100]);
  const r = repo.run('HEAD');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /lines coverage is 89 percent, below the required 90/);
});

test('a missing coverage summary fails', (t) => {
  const repo = scratchRepo(t);
  repo.write('{"lines": 90, "branches": 88}');
  repo.git('add', '.');
  repo.git('commit', '-q', '-m', 'base');
  rmSync(join(repo.dir, 'coverage'), { recursive: true });
  const r = repo.run('HEAD');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /cannot read coverage\/coverage-summary\.json/);
});

// The bypass this check exists for: weaken the vitest thresholds and add
// untested code in the same change. vitest then passes; the check must not.
test('zeroed vitest thresholds and an untested function still fail the check', (t) => {
  const repo = scratchRepo(t);
  for (const path of [
    'package.json',
    'tsconfig.json',
    'vitest.config.ts',
    'coverage-baseline.json',
    'src',
    'test',
  ]) {
    cpSync(join(root, path), join(repo.dir, path), { recursive: true });
  }
  symlinkSync(join(root, 'node_modules'), join(repo.dir, 'node_modules'));
  rmSync(join(repo.dir, 'coverage'), { recursive: true });
  writeFileSync(join(repo.dir, '.gitignore'), 'node_modules\ncoverage\n');
  repo.git('add', '.');
  repo.git('commit', '-q', '-m', 'base');

  const configPath = join(repo.dir, 'vitest.config.ts');
  const config = readFileSync(configPath, 'utf8');
  const weakened = config
    .replace('Math.max(FLOOR, baseline.lines)', '0')
    .replace('Math.max(FLOOR, baseline.branches)', '0');
  assert.notEqual(weakened, config, 'the threshold expressions were found and replaced');
  writeFileSync(configPath, weakened);
  writeFileSync(
    join(repo.dir, 'src', 'pick.ts'),
    'export function pick(flag: boolean): number {\n  if (flag) {\n    return 1;\n  }\n  return 2;\n}\n',
  );

  const vitest = spawnSync(
    process.execPath,
    [join(root, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--coverage'],
    { cwd: repo.dir, env: repo.env, encoding: 'utf8' },
  );
  assert.equal(
    vitest.status,
    0,
    `vitest alone lets this through\n${vitest.stdout}${vitest.stderr}`,
  );

  const r = repo.run('HEAD');
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /lines coverage is [\d.]+ percent, below the required \d+/);
  assert.match(r.stderr, /branches coverage is 0 percent, below the required \d+/);
});

test('the check passes when the baseline rises and fails when it falls', (t) => {
  const repo = scratchRepo(t);
  repo.write('{"lines": 90, "branches": 88}');
  repo.git('add', '.');
  repo.git('commit', '-q', '-m', 'base');
  const base = repo.git('rev-parse', 'HEAD');

  repo.write('{"lines": 91, "branches": 88}');
  let r = repo.run(base);
  assert.equal(r.status, 0, r.stderr);

  repo.write('{"lines": 90, "branches": 87}');
  r = repo.run(base);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /branches baseline fell from 88 to 87/);
});

test('the check passes when the base has no baseline yet', (t) => {
  const repo = scratchRepo(t);
  writeFileSync(join(repo.dir, 'README.md'), 'x\n');
  repo.git('add', '.');
  repo.git('commit', '-q', '-m', 'base');
  repo.write('{"lines": 85, "branches": 85}');
  const r = repo.run('HEAD');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no baseline at HEAD/);
});

test('an unresolvable base fails instead of skipping the comparison', (t) => {
  const repo = scratchRepo(t);
  repo.write('{"lines": 90, "branches": 90}');
  repo.git('add', '.');
  repo.git('commit', '-q', '-m', 'base');
  for (const base of ['origin/missing', '0123456789abcdef0123456789abcdef01234567', '']) {
    const r = repo.run(base);
    assert.equal(r.status, 1, `base ${JSON.stringify(base)}`);
    assert.match(r.stderr, /cannot resolve base/);
  }
  const r = repo.run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /usage/);
});

test('a missing baseline in the working tree fails', (t) => {
  const repo = scratchRepo(t);
  writeFileSync(join(repo.dir, 'README.md'), 'x\n');
  repo.git('add', '.');
  repo.git('commit', '-q', '-m', 'base');
  const r = repo.run('HEAD');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /cannot read coverage-baseline\.json/);
});

test('outside a repository the check fails', (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'coverage-baseline-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'coverage-baseline.json'), '{"lines": 90, "branches": 90}');
  mkdirSync(join(dir, 'coverage'));
  writeFileSync(join(dir, 'coverage', 'coverage-summary.json'), summaryText([1, 1], [0, 0]));
  const env = { ...cleanEnv(), GIT_CEILING_DIRECTORIES: dir };
  const r = spawnSync(process.execPath, [script, 'HEAD'], { cwd: dir, env, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /cannot resolve base/);
});
