// Run with: node --test .github/scripts/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import run, {
  activityPeriod,
  auditBranch,
  issueTitle,
  missingProtection,
  triage,
  windowStart,
} from './branch-audit.mjs';

const sha = (c) => c.repeat(40);
const since = new Date('2026-10-04T06:00:00Z');
const inWindow = '2026-10-05T12:00:00Z';

function act(activity_type, before, after, timestamp = inWindow, login = 'someone') {
  return { activity_type, before, after, timestamp, actor: { login } };
}

// Lookups for a clean squash merge of #3 (head a, merge commit 1, previous tip 0f).
function lookups(overrides = {}) {
  return {
    findMergedPr: async (s) => (s === sha('1') ? { number: 3, mergeCommitSha: sha('1'), headSha: sha('a') } : null),
    compareRange: async () => ({ status: 'ahead', commits: [sha('1')] }),
    prContains: async () => false,
    recomputeGate: async () => ({ state: 'success', description: 'ok' }),
    ...overrides,
  };
}

const audit = (activities, l = lookups()) => auditBranch({ branch: 'main', activities, since, lookups: l });

test('a reviewed squash merge is clean', async () => {
  assert.deepEqual(await audit([act('pr_merge', sha('f'), sha('1'))]), []);
});

test('a plain direct push is flagged', async () => {
  const v = await audit([act('push', sha('1'), sha('2'), inWindow, 'mallory')]);
  assert.deepEqual(v, [{ branch: 'main', sha: sha('2'), reason: 'direct push by mallory' }]);
});

test('a backdated direct push is flagged, because only the push time matters', async () => {
  // The commit claims 2020, but the activity log records when it was pushed.
  // Nothing about the commit's own date is consulted.
  const v = await audit([act('push', sha('1'), sha('3'))]);
  assert.equal(v.length, 1);
  assert.match(v[0].reason, /direct push/);
});

test('force pushes, deletions and unexpected activity are flagged', async () => {
  const v = await audit([
    act('force_push', sha('b'), sha('c'), inWindow, 'x'),
    act('branch_deletion', sha('d'), sha('0'), inWindow, 'y'),
    act('branch_creation', sha('0'), sha('e'), inWindow, 'z'),
    act('merge_queue_merge', sha('e'), sha('9'), inWindow, 'z'),
  ]);
  assert.deepEqual(
    v.map((x) => [x.sha, x.reason]),
    [
      [sha('c'), 'force push by x (was bbbbbbb)'],
      [sha('d'), 'branch deleted by y'],
      [sha('e'), 'branch_creation by z'],
      [sha('9'), 'merge_queue_merge by z'],
    ],
  );
});

test('activity before the window is ignored', async () => {
  assert.deepEqual(await audit([act('push', sha('1'), sha('2'), '2026-10-01T00:00:00Z')]), []);
});

test('a merge with no matching merged pull request is flagged', async () => {
  const v = await audit([act('pr_merge', sha('f'), sha('7'))]);
  assert.match(v[0].reason, /no matching merged pull request/);
});

test('a commit in the merge range that is not in the pull request is flagged', async () => {
  const l = lookups({
    compareRange: async () => ({ status: 'ahead', commits: [sha('5'), sha('6'), sha('1')] }),
    prContains: async (_pr, s) => s === sha('5'),
  });
  const v = await audit([act('pr_merge', sha('f'), sha('1'))], l);
  assert.deepEqual(v.map((x) => x.sha), [sha('6')]);
  assert.match(v[0].reason, /not part of that pull request/);
});

test('a merge range that does not extend the previous tip is flagged', async () => {
  const l = lookups({ compareRange: async () => ({ status: 'diverged', commits: [sha('1')] }) });
  const v = await audit([act('pr_merge', sha('f'), sha('1'))], l);
  assert.match(v[0].reason, /does not extend the previous tip \(diverged\)/);
});

test('the merge range checked is exactly the activity before...after', async () => {
  const asked = [];
  const l = lookups({
    compareRange: async (a, b) => {
      asked.push([a, b]);
      return { status: 'ahead', commits: [sha('1')] };
    },
  });
  await audit([act('pr_merge', sha('f'), sha('1'))], l);
  assert.deepEqual(asked, [[sha('f'), sha('1')]]);
});

test('a merge whose recomputed review fails is flagged, and the map is read at the previous tip', async () => {
  const refs = [];
  const l = lookups({
    recomputeGate: async (_pr, ref) => {
      refs.push(ref);
      return { state: 'failure', description: 'missing: qa-verifier' };
    },
  });
  const v = await audit([act('pr_merge', sha('f'), sha('1'))], l);
  assert.equal(v.length, 1);
  assert.match(v[0].reason, /#3 merged without passing review \(missing: qa-verifier\)/);
  assert.deepEqual(refs, [sha('f')]);
});

test('findings are deduplicated within a run and against open and closed issues', () => {
  const v = [
    { branch: 'main', sha: sha('1'), reason: 'a' },
    { branch: 'main', sha: sha('1'), reason: 'b' },
    { branch: 'main', sha: sha('2'), reason: 'c' },
    { branch: 'main', sha: sha('3'), reason: 'd' },
  ];
  const t = triage(v, [
    { title: issueTitle('main', sha('2')), state: 'open' },
    { title: issueTitle('main', sha('3')), state: 'closed' },
  ]);
  assert.deepEqual(t.toOpen.map((o) => o.title), ['branch-audit: main 1111111']);
  assert.deepEqual(t.stillOpen.map((x) => x.reason), ['c']);
  assert.deepEqual(t.acknowledged.map((x) => x.reason), ['d']);
});

test('an open issue wins over a closed one with the same title', () => {
  const title = issueTitle('main', sha('2'));
  const t = triage([{ branch: 'main', sha: sha('2'), reason: 'c' }], [
    { title, state: 'closed' },
    { title, state: 'open' },
  ]);
  assert.equal(t.stillOpen.length, 1);
  assert.equal(t.acknowledged.length, 0);
});

test('the window starts an hour before the last audit, or a week back without one', () => {
  const now = new Date('2026-10-13T06:00:00Z');
  assert.equal(windowStart(new Date('2026-10-12T06:00:00Z'), now).toISOString(), '2026-10-12T05:00:00.000Z');
  assert.equal(windowStart(null, now).toISOString(), '2026-10-06T06:00:00.000Z');
  // An audit that last passed a month ago widens the window to a month.
  assert.equal(windowStart(new Date('2026-09-13T06:00:00Z'), now).toISOString(), '2026-09-13T05:00:00.000Z');
});

test('the activity period is the smallest one that covers the window', () => {
  const now = new Date('2026-10-13T06:00:00Z');
  const back = (days) => new Date(now.getTime() - days * 86400000);
  assert.equal(activityPeriod(back(0.9), now), 'day');
  assert.equal(activityPeriod(back(1.5), now), 'week');
  assert.equal(activityPeriod(back(7), now), 'week');
  assert.equal(activityPeriod(back(10), now), 'month');
  assert.equal(activityPeriod(back(60), now), 'quarter');
  assert.equal(activityPeriod(back(200), now), 'year');
});

// End to end through run() with a fake client.

const HEAD = sha('a');
const MAP = {
  always: ['code-reviewer', 'qa-verifier', 'hygiene-auditor'],
  hotfix: { base: 'main', require: ['release-approver'] },
};
const mergedAt = '2026-10-05T12:00:00Z';

function marker(reviewer) {
  return `<!-- juncta-review reviewer=${reviewer} sha=${HEAD} verdict=approve -->`;
}
function comment(id, body, at = '2026-10-05T11:00:00Z') {
  return { id, body, author_association: 'MEMBER', created_at: at, updated_at: at, user: { login: 'r' } };
}
const approvals = ['code-reviewer', 'qa-verifier', 'hygiene-auditor', 'release-approver'].map((r, i) => comment(i + 1, marker(r)));

// The last passing scheduled audit, on the default branch. With the hour of
// slack the window starts at 2026-10-04T06:00Z, two days before now.
const TIP = sha('d');
const lastRun = { event: 'schedule', head_branch: 'development', head_sha: sha('c'), created_at: '2026-10-04T07:00:00Z' };

function fakeGithub({
  isPrivate = true,
  rules = {},
  activityPages = {},
  comments = approvals,
  issues = [],
  runs = [lastRun],
  onDefaultBranch = (s) => s === sha('c'),
}) {
  const created = [];
  const labels = [];
  const configRefs = [];
  const activityRequests = [];
  const activityPeriods = [];
  const statusReads = [];
  const runQueries = [];
  const issueQueries = [];
  const rulesQueries = [];
  const page = (data) => ({ data });
  const github = {
    paginate: async (route, params, map) => {
      if (typeof route === 'string') {
        activityRequests.push(params.ref);
        activityPeriods.push(params.time_period);
      }
      const pages =
        typeof route === 'string'
          ? activityPages[params.ref.replace('refs/heads/', '')] ?? [[]]
          : [(await route(params)).data];
      const out = [];
      let stop = false;
      for (const data of pages) {
        if (typeof route === 'string') activityRequests.push(`page:${params.ref}`);
        out.push(...(map ? map(page(data), () => (stop = true)) : data));
        if (stop) break;
      }
      return out;
    },
    rest: {
      repos: {
        get: async () => page({ private: isPrivate, default_branch: 'development' }),
        getBranchRules: async (p) => {
          rulesQueries.push(p.branch);
          const r = rules[p.branch] ?? [];
          if (r instanceof Error) throw r;
          return page(r);
        },
        getBranch: async (p) => {
          assert.equal(p.branch, 'development');
          return page({ commit: { sha: TIP } });
        },
        getContent: async (p) => {
          configRefs.push(p.ref);
          return page({ type: 'file', content: Buffer.from(JSON.stringify(MAP)).toString('base64') });
        },
        compareCommitsWithBasehead: async (p) => {
          const [base, head] = p.basehead.split('...');
          if (head === TIP) return page({ status: onDefaultBranch(base) ? 'ahead' : 'diverged', total_commits: 0, commits: [] });
          return page({ status: 'ahead', total_commits: 1, commits: [{ sha: sha('1') }] });
        },
        // A forged status would be found here; the audit must never ask.
        listCommitStatusesForRef: async (p) => {
          statusReads.push(p.ref);
          return page([{ context: 'review-gate', state: 'success' }]);
        },
      },
      pulls: {
        list: async () =>
          page([{ number: 3, merged_at: mergedAt, updated_at: mergedAt, merge_commit_sha: sha('1'), head: { sha: HEAD } }]),
        get: async () =>
          page({ number: 3, merged_at: mergedAt, changed_files: 1, labels: [], head: { sha: HEAD } }),
        listFiles: async () => page([{ filename: 'README.md' }]),
        listCommits: async () => page([{ sha: HEAD }]),
      },
      actions: {
        listWorkflowRuns: async (p) => {
          runQueries.push(p);
          return page({ workflow_runs: runs });
        },
      },
      issues: {
        listComments: async () => page(comments),
        listForRepo: async (p) => {
          issueQueries.push(p);
          return page(issues);
        },
        getLabel: async () => {
          const err = new Error('Not Found');
          err.status = 404;
          throw err;
        },
        createLabel: async (p) => labels.push(p.name),
        create: async (p) => created.push(p),
      },
    },
  };
  return {
    github,
    created,
    labels,
    configRefs,
    activityRequests,
    activityPeriods,
    statusReads,
    runQueries,
    issueQueries,
    rulesQueries,
  };
}

const context = { repo: { owner: 'junctaxyz', repo: 'juncta-api' }, serverUrl: 'https://github.com', runId: 5 };
const now = new Date('2026-10-06T06:00:00Z');
function core() {
  return {
    infos: [],
    warnings: [],
    info(m) { this.infos.push(m); },
    warning(m) { this.warnings.push(m); },
    failed: null,
    setFailed(m) { this.failed = m; },
  };
}
const merge = act('pr_merge', sha('f'), sha('1'), mergedAt);

test('run passes a reviewed merge and reads the map at the previous tip', async () => {
  const fake = fakeGithub({ activityPages: { development: [[merge]] } });
  const c = core();
  const v = await run({ github: fake.github, context, core: c, now });
  assert.deepEqual(v, []);
  assert.equal(c.failed, null);
  assert.deepEqual(fake.configRefs, [sha('f')]);
});

test('run ignores a forged success status and flags the unreviewed merge', async () => {
  const fake = fakeGithub({ activityPages: { development: [[merge]] }, comments: [] });
  const c = core();
  const v = await run({ github: fake.github, context, core: c, now });
  assert.equal(v.length, 1);
  assert.match(v[0].reason, /merged without passing review \(missing: code-reviewer, hygiene-auditor, qa-verifier\)/);
  assert.deepEqual(fake.statusReads, []);
  assert.deepEqual(fake.created.map((i) => i.title), ['branch-audit: development 1111111']);
});

test('run does not count markers posted after the merge', async () => {
  const late = ['code-reviewer', 'qa-verifier', 'hygiene-auditor'].map((r, i) =>
    comment(i + 10, marker(r), '2026-10-05T13:00:00Z'),
  );
  const fake = fakeGithub({ activityPages: { development: [[merge]] }, comments: late });
  const v = await run({ github: fake.github, context, core: core(), now });
  assert.equal(v.length, 1);
});

test('run reads activity across pages and stops at the window start', async () => {
  const filler = Array.from({ length: 100 }, () => merge);
  const fake = fakeGithub({
    activityPages: {
      main: [filler, [act('push', sha('1'), sha('2'), '2026-10-04T07:00:00Z'), act('push', sha('3'), sha('4'), '2026-10-01T00:00:00Z')], [act('push', sha('5'), sha('6'), '2026-09-30T00:00:00Z')]],
    },
  });
  const c = core();
  const v = await run({ github: fake.github, context, core: c, now });
  // The push on page two is found; the out-of-window ones are not.
  assert.deepEqual(v.map((x) => x.sha), [sha('2')]);
  // Two pages were read for main; the third was never requested.
  assert.equal(fake.activityRequests.filter((r) => r === 'page:refs/heads/main').length, 2);
});

test('run labels the issue, fails the job and does not reopen an open issue', async () => {
  const fake = fakeGithub({ activityPages: { main: [[act('push', sha('8'), sha('9'))]] } });
  const c = core();
  await run({ github: fake.github, context, core: c, now });
  assert.deepEqual(fake.created.map((i) => [i.title, i.labels]), [['branch-audit: main 9999999', ['branch-audit']]]);
  assert.deepEqual(fake.labels, ['branch-audit']);
  assert.match(c.failed, /1 branch audit finding/);

  const again = fakeGithub({
    activityPages: { main: [[act('push', sha('8'), sha('9'))]] },
    issues: [{ title: 'branch-audit: main 9999999', state: 'open' }],
  });
  const c2 = core();
  await run({ github: again.github, context, core: c2, now });
  assert.equal(again.created.length, 0);
  assert.match(c2.failed, /0 new issue/);
});

// Active rules that make a branch safe to leave unaudited.
const FULL_RULES = [
  { type: 'pull_request', parameters: { required_approving_review_count: 0 } },
  { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'review-gate' }] } },
  { type: 'non_fast_forward' },
  { type: 'deletion' },
];
const ALL_PROTECTED = { main: FULL_RULES, staging: FULL_RULES, development: FULL_RULES };

test('missingProtection names each rule a branch lacks', () => {
  assert.deepEqual(missingProtection(FULL_RULES), []);
  assert.deepEqual(missingProtection([]), [
    'pull requests required',
    'review-gate status required',
    'force pushes blocked',
    'deletion blocked',
  ]);
  const otherCheck = FULL_RULES.map((r) =>
    r.type === 'required_status_checks'
      ? { ...r, parameters: { required_status_checks: [{ context: 'ci' }] } }
      : r,
  );
  assert.deepEqual(missingProtection(otherCheck), ['review-gate status required']);
  assert.deepEqual(
    missingProtection(FULL_RULES.filter((r) => r.type !== 'non_fast_forward')),
    ['force pushes blocked'],
  );
});

test('run audits a public repository whose branches are not protected', async () => {
  const fake = fakeGithub({ isPrivate: false, activityPages: { main: [[act('push', sha('8'), sha('9'))]] } });
  const c = core();
  const v = await run({ github: fake.github, context, core: c, now });
  assert.deepEqual(v.map((x) => x.reason), ['direct push by someone']);
  assert.deepEqual(fake.created.map((i) => i.title), ['branch-audit: main 9999999']);
  assert.match(c.failed, /1 branch audit finding/);
  assert.deepEqual(fake.rulesQueries.sort(), ['development', 'main', 'staging']);
  assert.ok(c.warnings.some((w) => /main: .*pull requests required/.test(w)), c.warnings.join('\n'));
});

test('run skips only the branches whose rules enforce the review flow', async () => {
  const fake = fakeGithub({
    isPrivate: false,
    rules: { main: FULL_RULES, staging: FULL_RULES, development: FULL_RULES.slice(1) },
    activityPages: {
      main: [[act('push', sha('8'), sha('9'))]],
      development: [[act('push', sha('6'), sha('7'))]],
    },
  });
  const v = await run({ github: fake.github, context, core: core(), now });
  assert.deepEqual(v.map((x) => x.sha), [sha('7')]);
  assert.ok(!fake.activityRequests.includes('refs/heads/main'));
});

test('run does nothing on a public repository whose branches are all protected', async () => {
  const fake = fakeGithub({
    isPrivate: false,
    rules: ALL_PROTECTED,
    activityPages: { main: [[act('push', sha('8'), sha('9'))]] },
  });
  const c = core();
  assert.deepEqual(await run({ github: fake.github, context, core: c, now }), []);
  assert.equal(fake.activityRequests.length, 0);
  assert.equal(c.failed, null);
});

test('run fails when the branch rules cannot be read', async () => {
  const err = new Error('Resource not accessible by integration');
  err.status = 403;
  const fake = fakeGithub({ isPrivate: false, rules: { ...ALL_PROTECTED, staging: err } });
  await assert.rejects(run({ github: fake.github, context, core: core(), now }), /not accessible/);
});

test('run audits every branch of a private repository without reading rules', async () => {
  const fake = fakeGithub({ rules: ALL_PROTECTED, activityPages: { main: [[act('push', sha('8'), sha('9'))]] } });
  const v = await run({ github: fake.github, context, core: core(), now });
  assert.equal(v.length, 1);
  assert.deepEqual(fake.rulesQueries, []);
});

test('run deduplicates against closed issues and passes once every finding is closed', async () => {
  const fake = fakeGithub({
    activityPages: { main: [[act('push', sha('8'), sha('9'))]] },
    issues: [{ title: 'branch-audit: main 9999999', state: 'closed' }],
  });
  const c = core();
  const v = await run({ github: fake.github, context, core: c, now });
  assert.equal(v.length, 1);
  assert.equal(fake.created.length, 0);
  assert.equal(c.failed, null);
  assert.deepEqual(fake.issueQueries.map((q) => [q.state, q.labels]), [['all', 'branch-audit']]);
});

test('run starts from the last passing audit on the default branch', async () => {
  const fake = fakeGithub({ activityPages: { main: [[act('push', sha('1'), sha('2'), '2026-10-03T00:00:00Z')]] } });
  const v = await run({ github: fake.github, context, core: core(), now });
  // 2026-10-03 is before the window that run left off at.
  assert.deepEqual(v, []);
  assert.deepEqual(fake.runQueries.map((q) => [q.workflow_id, q.branch, q.status]), [
    ['branch-audit.yml', 'development', 'success'],
  ]);
  assert.deepEqual([...new Set(fake.activityPeriods)], ['week']);
});

test('run reads a full week when no audit has passed', async () => {
  const fake = fakeGithub({
    runs: [],
    activityPages: {
      main: [[act('push', sha('1'), sha('2'), '2026-10-01T00:00:00Z'), act('push', sha('3'), sha('4'), '2026-09-28T00:00:00Z')]],
    },
  });
  const v = await run({ github: fake.github, context, core: core(), now });
  assert.deepEqual(v.map((x) => x.sha), [sha('2')]);
  assert.deepEqual([...new Set(fake.activityPeriods)], ['week']);
});

test('run widens the window after a long gap, as when runner minutes ran out', async () => {
  const fake = fakeGithub({
    runs: [{ ...lastRun, created_at: '2026-09-16T06:00:00Z' }],
    activityPages: { main: [[act('push', sha('1'), sha('2'), '2026-09-20T00:00:00Z')]] },
  });
  const v = await run({ github: fake.github, context, core: core(), now });
  assert.deepEqual(v.map((x) => x.sha), [sha('2')]);
  assert.deepEqual([...new Set(fake.activityPeriods)], ['month']);
});

test('run ignores passing runs that did not audit the default branch', async () => {
  // Each of these could come from a workflow edited on a side branch or tag.
  const runs = [
    { ...lastRun, head_branch: 'feat/1-x', created_at: '2026-10-06T05:00:00Z' },
    { ...lastRun, event: 'push', created_at: '2026-10-06T05:00:00Z' },
    { ...lastRun, head_sha: sha('e'), created_at: '2026-10-06T05:00:00Z' },
  ];
  const fake = fakeGithub({
    runs,
    activityPages: { main: [[act('push', sha('1'), sha('2'), '2026-10-01T00:00:00Z')]] },
  });
  const v = await run({ github: fake.github, context, core: core(), now });
  // None counts, so the window is a full week and the push is found.
  assert.deepEqual(v.map((x) => x.sha), [sha('2')]);
});
