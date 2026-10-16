// Run with: node --test .github/scripts/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import run, {
  evaluate,
  globToRegExp,
  matchesAny,
  parseMarkers,
  requiredReviewers,
  validateConfig,
} from './review-gate.mjs';

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const ALWAYS = ['code-reviewer', 'hygiene-auditor', 'qa-verifier'];

const config = {
  always: ALWAYS,
  rules: [
    {
      paths: ['programs/**', 'crates/juncta-math/**'],
      require: ['contract-security-auditor', 'exploit-tester'],
    },
    { labels: ['economics'], require: ['economic-risk-reviewer'] },
    { paths: ['.github/**', '**/Cargo.lock'], require: ['security-reviewer'] },
  ],
  hotfix: { base: 'main', require: ['release-approver'] },
};

let nextId = 1;
function comment(lines, opts = {}) {
  const at = opts.at ?? new Date(Date.UTC(2026, 9, 6, 10, 0, 0) + nextId * 1000).toISOString();
  return {
    id: nextId++,
    body: Array.isArray(lines) ? lines.join('\n') : lines,
    author_association: opts.association ?? 'MEMBER',
    created_at: at,
    updated_at: opts.updatedAt ?? at,
    user: { login: 'Divine572' },
  };
}

function marker(reviewer, verdict = 'approve', sha = HEAD) {
  return `<!-- juncta-review reviewer=${reviewer} sha=${sha} verdict=${verdict} -->`;
}

function approveAll(names) {
  return names.map((n) => comment(['Looks good.', '', marker(n)]));
}

function gate(comments, overrides = {}) {
  return evaluate({
    config,
    files: ['README.md'],
    labels: [],
    baseRef: 'development',
    comments,
    headSha: HEAD,
    ...overrides,
  });
}

test('valid markers from every required reviewer pass', () => {
  const r = gate(approveAll(ALWAYS));
  assert.equal(r.state, 'success');
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.required, ALWAYS);
});

test('a marker for another SHA does not count', () => {
  const comments = [
    ...approveAll(['code-reviewer', 'qa-verifier']),
    comment(marker('hygiene-auditor', 'approve', OLD)),
  ];
  const r = gate(comments);
  assert.equal(r.state, 'failure');
  assert.deepEqual(r.missing, ['hygiene-auditor']);
  assert.match(r.ignored[0].reason, /for bbbbbbb/);
});

test('an edited comment does not count', () => {
  const comments = [
    ...approveAll(['code-reviewer', 'qa-verifier']),
    comment(marker('hygiene-auditor'), {
      at: '2026-10-06T11:00:00Z',
      updatedAt: '2026-10-06T11:05:00Z',
    }),
  ];
  const r = gate(comments);
  assert.equal(r.state, 'failure');
  assert.deepEqual(r.missing, ['hygiene-auditor']);
  assert.equal(r.ignored[0].reason, 'comment was edited');
});

test('a marker from someone outside the repo does not count', () => {
  for (const association of ['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'NONE']) {
    const comments = [
      ...approveAll(['code-reviewer', 'qa-verifier']),
      comment(marker('hygiene-auditor'), { association }),
    ];
    const r = gate(comments);
    assert.equal(r.state, 'failure', association);
    assert.deepEqual(r.missing, ['hygiene-auditor']);
  }
});

test('owners and collaborators count like members', () => {
  const comments = [
    comment(marker('code-reviewer'), { association: 'OWNER' }),
    comment(marker('qa-verifier'), { association: 'COLLABORATOR' }),
    comment(marker('hygiene-auditor')),
  ];
  assert.equal(gate(comments).state, 'success');
});

test('a later changes_requested overrides an earlier approve', () => {
  const comments = [
    ...approveAll(ALWAYS),
    comment(marker('qa-verifier', 'changes_requested'), { at: '2026-10-06T12:00:00Z' }),
  ];
  const r = gate(comments);
  assert.equal(r.state, 'failure');
  assert.deepEqual(r.rejected, ['qa-verifier']);
  assert.match(r.description, /changes requested: qa-verifier/);
});

test('a later approve overrides an earlier changes_requested', () => {
  const comments = [
    comment(marker('qa-verifier', 'changes_requested'), { at: '2026-10-06T09:00:00Z' }),
    ...approveAll(ALWAYS),
  ];
  assert.equal(gate(comments).state, 'success');
});

test('order is by creation time, not by list order', () => {
  const comments = [
    comment(marker('qa-verifier', 'changes_requested'), { at: '2026-10-06T23:00:00Z' }),
    ...approveAll(ALWAYS),
  ];
  assert.equal(gate(comments).state, 'failure');
});

test('changes_requested from a reviewer who was not required still fails', () => {
  const comments = [
    ...approveAll(ALWAYS),
    comment(marker('performance-reviewer', 'changes_requested')),
  ];
  const r = gate(comments);
  assert.equal(r.state, 'failure');
  assert.deepEqual(r.rejected, ['performance-reviewer']);
});

test('a missing reviewer fails and is named', () => {
  const r = gate(approveAll(['code-reviewer', 'hygiene-auditor']));
  assert.equal(r.state, 'failure');
  assert.equal(r.description, 'missing: qa-verifier');
});

test('a path rule adds reviewers', () => {
  const files = ['programs/juncta/src/dex/swap.rs'];
  const r = gate(approveAll(ALWAYS), { files });
  assert.equal(r.state, 'failure');
  assert.deepEqual(r.missing, ['contract-security-auditor', 'exploit-tester']);
  const ok = gate(approveAll([...ALWAYS, 'contract-security-auditor', 'exploit-tester']), {
    files,
  });
  assert.equal(ok.state, 'success');
});

test('a rename out of a sensitive path still needs its reviewers', () => {
  const required = requiredReviewers(config, {
    files: ['moved/math.rs', 'crates/juncta-math/src/lib.rs'],
    labels: [],
    baseRef: 'development',
  });
  assert.ok(required.includes('contract-security-auditor'));
});

test('a label rule adds reviewers', () => {
  const r = gate(approveAll(ALWAYS), { labels: ['economics'] });
  assert.equal(r.state, 'failure');
  assert.deepEqual(r.missing, ['economic-risk-reviewer']);
});

test('pull requests into the hotfix base need the release approver', () => {
  const r = gate(approveAll(ALWAYS), { baseRef: 'main' });
  assert.equal(r.state, 'failure');
  assert.deepEqual(r.missing, ['release-approver']);
  assert.equal(gate(approveAll([...ALWAYS, 'release-approver']), { baseRef: 'main' }).state, 'success');
  assert.equal(gate(approveAll(ALWAYS), { baseRef: 'staging' }).state, 'success');
});

test('a marker that is not on its own line does not count', () => {
  const bad = [
    `Approved ${marker('qa-verifier')}`,
    `${marker('qa-verifier')} thanks`,
    ` ${marker('qa-verifier')}`,
    `> ${marker('qa-verifier')}`,
    `\`${marker('qa-verifier')}\``,
  ];
  for (const line of bad) {
    assert.deepEqual(parseMarkers(line), [], line);
    const r = gate([...approveAll(['code-reviewer', 'hygiene-auditor']), comment(line)]);
    assert.deepEqual(r.missing, ['qa-verifier'], line);
  }
});

test('markers tolerate CRLF line endings and several per comment', () => {
  const body = `Summary\r\n${marker('code-reviewer')}\r\n${marker('qa-verifier')}\r\n`;
  assert.equal(parseMarkers(body).length, 2);
});

test('malformed markers are ignored', () => {
  const bad = [
    marker('qa-verifier', 'approve', HEAD.slice(1)),
    marker('qa-verifier', 'approve', 'A'.repeat(40)),
    marker('qa-verifier', 'lgtm'),
    marker('QA-verifier'),
    '<!--juncta-review reviewer=qa-verifier sha=' + HEAD + ' verdict=approve -->',
  ];
  for (const line of bad) assert.deepEqual(parseMarkers(line), [], line);
});

test('glob matching', () => {
  const cases = [
    ['programs/**', 'programs/juncta/src/lib.rs', true],
    ['programs/**', 'programs', false],
    ['programs/**', 'xprograms/a', false],
    ['**/Cargo.lock', 'Cargo.lock', true],
    ['**/Cargo.lock', 'fuzz/Cargo.lock', true],
    ['**/Cargo.lock', 'fuzz/Cargo.lock.bak', false],
    ['.github/**', '.github/workflows/ci.yml', true],
    ['crates/*/src/lib.rs', 'crates/indexer/src/lib.rs', true],
    ['crates/*/src/lib.rs', 'crates/a/b/src/lib.rs', false],
    ['crates/**/bench/*.rs', 'crates/bench/x.rs', true],
    ['crates/**/bench/*.rs', 'crates/a/b/bench/x.rs', true],
    ['src/?.ts', 'src/a.ts', true],
    ['src/?.ts', 'src/ab.ts', false],
    ['next.config.*', 'next.config.ts', true],
    ['a.b', 'aXb', false],
    ['(x)+', '(x)+', true],
    ['**', 'anything/at/all', true],
  ];
  for (const [glob, path, want] of cases) {
    assert.equal(globToRegExp(glob).test(path), want, `${glob} vs ${path}`);
  }
  assert.ok(matchesAny('go.sum', ['**/go.sum']));
});

test('config validation rejects mistakes', () => {
  assert.throws(() => validateConfig({}), /always/);
  assert.throws(() => validateConfig({ always: [] }), /at least one/);
  assert.throws(() => validateConfig({ always: ['Code Reviewer'] }), /lowercase/);
  assert.throws(() => validateConfig({ always: ALWAYS, extra: 1 }), /unknown config key/);
  assert.throws(() => validateConfig({ always: ALWAYS, rules: [{ require: ['x'] }] }), /paths or labels/);
  assert.throws(
    () => validateConfig({ always: ALWAYS, rules: [{ path: ['a'], require: ['x'] }] }),
    /unknown key "path"/,
  );
  assert.throws(() => validateConfig({ always: ALWAYS, hotfix: { require: ['x'] } }), /hotfix.base/);
  assert.equal(validateConfig(config), config);
});

// A small stand-in for the Octokit client that github-script provides.
function fakeGithub({ pr, files, comments, configText }) {
  const statuses = [];
  const reads = [];
  const github = {
    paginate: async (fn, params) => (await fn(params)).data,
    rest: {
      pulls: {
        get: async () => ({ data: pr }),
        listFiles: async () => ({ data: files.map((f) => ({ filename: f })) }),
      },
      issues: { listComments: async () => ({ data: comments }) },
      repos: {
        getContent: async (params) => {
          reads.push(params.ref);
          if (configText === null) {
            const err = new Error('Not Found');
            err.status = 404;
            throw err;
          }
          return {
            data: { type: 'file', content: Buffer.from(configText).toString('base64') },
          };
        },
        createCommitStatus: async (params) => {
          statuses.push(params);
          return { data: {} };
        },
      },
    },
  };
  return { github, statuses, reads };
}

const context = {
  repo: { owner: 'junctaxyz', repo: 'juncta-protocol' },
  payload: { issue: { number: 7, pull_request: {} } },
  serverUrl: 'https://github.com',
  runId: 42,
};
const core = { info: () => {} };
const openPr = {
  state: 'open',
  head: { sha: HEAD },
  base: { ref: 'development' },
  labels: [],
  changed_files: 1,
};

test('run reads the config from the base branch and posts a status on the head SHA', async () => {
  const fake = fakeGithub({
    pr: openPr,
    files: ['README.md'],
    comments: approveAll(ALWAYS),
    configText: JSON.stringify(config),
  });
  await run({ github: fake.github, context, core });
  assert.deepEqual(fake.reads, ['development']);
  assert.equal(fake.statuses.length, 1);
  assert.equal(fake.statuses[0].sha, HEAD);
  assert.equal(fake.statuses[0].context, 'review-gate');
  assert.equal(fake.statuses[0].state, 'success');
  assert.equal(fake.statuses[0].target_url, 'https://github.com/junctaxyz/juncta-protocol/actions/runs/42');
});

test('run fails closed when the config is missing', async () => {
  const fake = fakeGithub({ pr: openPr, files: [], comments: approveAll(ALWAYS), configText: null });
  await run({ github: fake.github, context, core });
  assert.equal(fake.statuses[0].state, 'error');
  assert.match(fake.statuses[0].description, /not found on development/);
});

test('run fails closed when the file list is truncated', async () => {
  const fake = fakeGithub({
    pr: { ...openPr, changed_files: 3001 },
    files: ['README.md'],
    comments: approveAll(ALWAYS),
    configText: JSON.stringify(config),
  });
  await run({ github: fake.github, context, core });
  assert.equal(fake.statuses[0].state, 'error');
  assert.match(fake.statuses[0].description, /changed files/);
});

test('run leaves closed pull requests alone', async () => {
  const fake = fakeGithub({ pr: { ...openPr, state: 'closed' }, files: [], comments: [], configText: '{}' });
  assert.equal(await run({ github: fake.github, context, core }), null);
  assert.equal(fake.statuses.length, 0);
});

test('every shipped reviewer map is valid', async () => {
  const { readdir, readFile } = await import('node:fs/promises');
  const dir = new URL('../../review-gate/', import.meta.url);
  let names;
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.json'));
  } catch {
    // Inside a product repo the templates folder does not exist; the repo's
    // own map is checked instead.
    names = [];
  }
  const own = new URL('../review-gate.json', import.meta.url);
  const sources = names.map((n) => new URL(n, dir));
  try {
    await readFile(own);
    sources.push(own);
  } catch {
    // No map next to this script: nothing more to check.
  }
  for (const src of sources) {
    const cfg = validateConfig(JSON.parse(await readFile(src, 'utf8')));
    for (const r of ['code-reviewer', 'qa-verifier', 'hygiene-auditor']) {
      assert.ok(cfg.always.includes(r), `${src.pathname} always includes ${r}`);
    }
    assert.deepEqual(cfg.hotfix, { base: 'main', require: ['release-approver'] }, src.pathname);
  }
});

test('the workflow groups only evaluating runs, so a plain comment cannot cancel one', async () => {
  const { readFile } = await import('node:fs/promises');
  let text;
  try {
    text = await readFile(new URL('../workflows/review-gate.yml', import.meta.url), 'utf8');
  } catch {
    return; // Script copied without its workflow; nothing to check.
  }
  const lines = text.split('\n');
  // Workflow-level concurrency is assigned before the job condition runs,
  // which is exactly what must not happen here.
  assert.equal(lines.filter((l) => /^concurrency:/.test(l)).length, 0);
  const gate = lines.findIndex((l) => /^ {2}gate:/.test(l));
  const conc = lines.findIndex((l) => /^ {4}concurrency:/.test(l));
  assert.ok(gate >= 0 && conc > gate, 'concurrency is set on the gate job');
  assert.match(lines[conc + 2], /^ {6}cancel-in-progress: true$/);
});

test('every shipped reviewer map sends supply-chain files to security review', async () => {
  const { readdir, readFile } = await import('node:fs/promises');
  const dir = new URL('../../review-gate/', import.meta.url);
  const sources = [];
  try {
    for (const n of await readdir(dir)) if (n.endsWith('.json')) sources.push(new URL(n, dir));
  } catch {
    // Not in the templates folder.
  }
  try {
    const own = new URL('../review-gate.json', import.meta.url);
    await readFile(own);
    sources.push(own);
  } catch {
    // No map next to this script.
  }
  const supplyChain = [
    '.github/workflows/ci.yml',
    'scripts/install-ci-tools.sh',
    'tools/go.mod',
    '.cargo/config.toml',
    'deny.toml',
    'rust-toolchain.toml',
    'crates/indexer/Cargo.toml',
    'Cargo.lock',
    'go.sum',
    'pnpm-lock.yaml',
    'tools/requirements.txt',
  ];
  for (const src of sources) {
    const cfg = validateConfig(JSON.parse(await readFile(src, 'utf8')));
    for (const file of supplyChain) {
      const required = requiredReviewers(cfg, { files: [file], labels: [], baseRef: 'development' });
      assert.ok(required.includes('security-reviewer'), `${src.pathname}: ${file}`);
    }
  }
});

test('every shipped reviewer map sends gate code and scanner config to security review', async () => {
  const { readdir, readFile } = await import('node:fs/promises');
  const dir = new URL('../../review-gate/', import.meta.url);
  const sources = [];
  try {
    for (const n of await readdir(dir)) if (n.endsWith('.json')) sources.push(new URL(n, dir));
  } catch {
    // Not in the templates folder.
  }
  try {
    const own = new URL('../review-gate.json', import.meta.url);
    await readFile(own);
    sources.push(own);
  } catch {
    // No map next to this script.
  }
  // A change to any of these can quietly weaken a check: the gate scripts,
  // what the scanners skip, what coverage counts, what git ignores, and the
  // reviewer map itself.
  const gateFiles = [
    'scripts/hygiene.sh',
    'scripts/tests/hygiene_test.sh',
    'xtask/src/coverage.rs',
    '.githooks/pre-push',
    'osv-scanner.toml',
    '.semgrepignore',
    '.semgrep.yml',
    '.semgrep/rules.yaml',
    '.gitleaks.toml',
    '.gitleaksignore',
    'deny.toml',
    '.gitignore',
    'crates/indexer/.gitignore',
    'coverage-areas.toml',
    'coverage-baseline.json',
    'codecov.yml',
    '.config/nextest.toml',
    'vitest.config.ts',
    'packages/client/vitest.config.mts',
    'clippy.toml',
    '.golangci.yml',
    'eslint.config.mjs',
    '.nvmrc',
    '.github/review-gate.json',
  ];
  for (const src of sources) {
    const cfg = validateConfig(JSON.parse(await readFile(src, 'utf8')));
    for (const file of gateFiles) {
      const required = requiredReviewers(cfg, { files: [file], labels: [], baseRef: 'development' });
      assert.ok(required.includes('security-reviewer'), `${src.pathname}: ${file}`);
    }
  }
});
