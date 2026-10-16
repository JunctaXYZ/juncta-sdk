// Run with: node --test scripts/tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';
import { compareBaselines, parseBaseline } from '../check-coverage-baseline.mjs';

const script = fileURLToPath(new URL('../check-coverage-baseline.mjs', import.meta.url));

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

test('a lower baseline than the base is reported per metric', () => {
  const base = { lines: 95, branches: 90 };
  assert.deepEqual(compareBaselines(base, { lines: 95, branches: 90 }), []);
  assert.deepEqual(compareBaselines(base, { lines: 96, branches: 91 }), []);
  assert.deepEqual(compareBaselines(base, { lines: 94, branches: 90 }), [
    'lines baseline fell from 95 to 94',
  ]);
  assert.deepEqual(compareBaselines(base, { lines: 94, branches: 89 }), [
    'lines baseline fell from 95 to 94',
    'branches baseline fell from 90 to 89',
  ]);
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
  return { dir, git, run, write };
}

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
  const env = { ...cleanEnv(), GIT_CEILING_DIRECTORIES: dir };
  const r = spawnSync(process.execPath, [script, 'HEAD'], { cwd: dir, env, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /cannot resolve base/);
});
