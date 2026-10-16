// Run with: node --test scripts/tests/*.test.mjs
//
// The path filter in ci.yml skips the package jobs for changes under
// .github/, which is exactly where action pins change. These checks must
// therefore sit in a job with no condition at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';

const text = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');

// The lines of one job, from its key to the next job key.
function job(name) {
  const lines = text.split('\n');
  const start = lines.indexOf(`  ${name}:`);
  assert.ok(start >= 0, `ci.yml has a ${name} job`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^ {2}[A-Za-z0-9_-]+:\s*$/.test(l));
  return end < 0 ? rest : rest.slice(0, end);
}

test('repo-checks runs on every change, with no condition or dependency', () => {
  const lines = job('repo-checks');
  assert.ok(!lines.some((l) => /^ {4}(if|needs):/.test(l)), lines.join('\n'));
});

test('repo-checks runs the pin check and the decoy GIT_DIR test', () => {
  const runs = job('repo-checks').filter((l) => /^\s+run:/.test(l));
  assert.ok(
    runs.some((l) => l.includes('scripts/check-pins.sh')),
    runs.join('\n'),
  );
  assert.ok(
    runs.some((l) => l.includes('scripts/tests/git_env_test.sh')),
    runs.join('\n'),
  );
});
