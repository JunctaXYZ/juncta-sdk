// Run with: node --test .github/scripts/*.test.mjs
//
// The shared tests check the paths every repository has. These cover the
// files that only this package has and that can weaken a check without
// touching the code it checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { requiredReviewers, validateConfig } from './review-gate.mjs';

const map = validateConfig(
  JSON.parse(await readFile(new URL('../review-gate.json', import.meta.url), 'utf8')),
);

function required(file) {
  return requiredReviewers(map, { files: [file], labels: [], baseRef: 'development' });
}

test('package gate config goes to security review', () => {
  const gateFiles = [
    // What the type checker, the build and the docs build accept.
    'tsconfig.json',
    'tsconfig.build.json',
    'typedoc.json',
    // What lint, format and coverage look at.
    'eslint.config.js',
    'vitest.config.ts',
    '.prettierignore',
    '.prettierrc.json',
    'prettier.config.js',
    'coverage-baseline.json',
    // Release policy: publish access and how private packages are tagged.
    '.changeset/config.json',
    '.changeset/README.md',
    // Which install scripts may run, and the toolchain pins.
    'pnpm-workspace.yaml',
    '.npmrc',
    '.nvmrc',
    'package.json',
    'pnpm-lock.yaml',
    // The gate itself and its tests.
    'scripts/gate.sh',
    'scripts/check-coverage-baseline.mjs',
    'scripts/tests/pack_test.sh',
    '.github/workflows/ci.yml',
    '.semgrepignore',
    'osv-scanner.toml',
    '.gitignore',
  ];
  for (const file of gateFiles) {
    assert.ok(required(file).includes('security-reviewer'), file);
  }
});

test('the program interface and generated client go to contract review', () => {
  for (const file of ['idl/juncta.json', 'src/generated/instructions/swap.ts']) {
    const got = required(file);
    assert.ok(got.includes('contract-security-auditor'), file);
    assert.ok(got.includes('exploit-tester'), file);
  }
});

test('ordinary source needs only the standing reviewers', () => {
  assert.deepEqual(required('src/index.ts').sort(), [
    'code-reviewer',
    'hygiene-auditor',
    'qa-verifier',
  ]);
});
