// Checks that every change to the long-lived branches since the last passing
// audit arrived as a merged pull request that passed review, and opens one
// issue per problem.
//
// Private repositories on our plan cannot enforce branch protection, so this
// audit is how a direct push becomes visible. On a public repository, where
// protection is enforced, the audit does nothing.
//
// Two things here are deliberate:
// - The audit is driven by the repository activity log, not by commit dates.
//   Commit dates are written by whoever makes the commit, so a backdated
//   direct push would fall outside any date window.
// - Review is re-evaluated from the pull request's markers and files, with
//   the reviewer map the base branch had just before the merge. The
//   review-gate commit status is never trusted here, because anyone with
//   write access can post one.

import { changedFiles, evaluate, loadConfig } from './review-gate.mjs';

export const BRANCHES = ['main', 'staging', 'development'];
export const LABEL = 'branch-audit';
export const WORKFLOW_FILE = 'branch-audit.yml';
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
// Covers activity that is recorded a little after it happens.
const WINDOW_SLACK = HOUR;
const DEFAULT_WINDOW = 7 * DAY;
const PR_COMMIT_LIST_LIMIT = 250;
const ZERO_SHA = /^0+$/;

export function issueTitle(branch, sha) {
  return `branch-audit: ${branch} ${sha.slice(0, 7)}`;
}

function finding(branch, sha, reason) {
  return { branch, sha, reason };
}

// One merge from the activity log. lookups:
//   findMergedPr(sha)        merged pull request whose merge commit is sha, or null
//   compareRange(a, b)       { status, commits } for a...b
//   prContains(pr, sha)      whether sha is one of the pull request's commits
//   recomputeGate(pr, ref)   { state, description } with the map read at ref
async function auditMerge(branch, a, lookups) {
  if (!a.before || ZERO_SHA.test(a.before)) {
    return [finding(branch, a.after, 'merge recorded with no previous branch tip')];
  }
  const pr = await lookups.findMergedPr(a.after);
  if (!pr) {
    return [finding(branch, a.after, 'merge with no matching merged pull request')];
  }
  const out = [];
  const range = await lookups.compareRange(a.before, a.after);
  if (range.status !== 'ahead') {
    out.push(finding(branch, a.after, `merge of #${pr.number} does not extend the previous tip (${range.status})`));
  }
  // Every commit the merge added must belong to the pull request. Anything
  // else rode in alongside it without review.
  for (const sha of range.commits) {
    if (sha === pr.mergeCommitSha) continue;
    if (!(await lookups.prContains(pr, sha))) {
      out.push(finding(branch, sha, `commit is in the merge of #${pr.number} but not part of that pull request`));
    }
  }
  const gate = await lookups.recomputeGate(pr, a.before);
  if (gate.state !== 'success') {
    out.push(finding(branch, a.after, `#${pr.number} merged without passing review (${gate.description})`));
  }
  return out;
}

// activities: activity log entries for one branch, any order.
export async function auditBranch({ branch, activities, since, lookups }) {
  const violations = [];
  for (const a of activities) {
    if (Date.parse(a.timestamp) < since.getTime()) continue;
    const who = a.actor?.login ?? 'unknown';
    switch (a.activity_type) {
      case 'pr_merge':
        violations.push(...(await auditMerge(branch, a, lookups)));
        break;
      case 'push':
        violations.push(finding(branch, a.after, `direct push by ${who}`));
        break;
      case 'force_push':
        violations.push(finding(branch, a.after, `force push by ${who} (was ${a.before.slice(0, 7)})`));
        break;
      case 'branch_deletion':
        violations.push(finding(branch, a.before, `branch deleted by ${who}`));
        break;
      default:
        // Branch creation, merge queue merges and anything GitHub adds later
        // are outside the review flow until we decide otherwise.
        violations.push(finding(branch, ZERO_SHA.test(a.after ?? '') ? a.before : a.after, `${a.activity_type} by ${who}`));
    }
  }
  return violations;
}

// The window starts where the last passing audit started, less some slack,
// so runs that failed or never ran (no runner minutes left) leave no gap.
// With no passing audit to go on, a full week.
export function windowStart(lastAuditStart, now) {
  if (lastAuditStart) return new Date(lastAuditStart.getTime() - WINDOW_SLACK);
  return new Date(now.getTime() - DEFAULT_WINDOW);
}

// The activity API filters by a fixed period; pick the smallest that covers
// the window.
export function activityPeriod(since, now) {
  const age = now.getTime() - since.getTime();
  if (age <= DAY) return 'day';
  if (age <= 7 * DAY) return 'week';
  if (age <= 30 * DAY) return 'month';
  if (age <= 90 * DAY) return 'quarter';
  return 'year';
}

// Sorts findings against existing branch-audit issues, open and closed.
//   toOpen        one new issue per title with no issue yet
//   stillOpen     findings whose issue is still open
//   acknowledged  findings whose issue was closed after checking
// Windows overlap and a failed run is followed by a wider one, so the same
// finding is seen more than once. A closed issue means someone looked, and
// it is not reopened.
export function triage(violations, issues) {
  const open = new Set(issues.filter((i) => i.state === 'open').map((i) => i.title));
  const closed = new Set(issues.filter((i) => i.state !== 'open').map((i) => i.title));
  const queued = new Set();
  const out = { toOpen: [], stillOpen: [], acknowledged: [] };
  for (const v of violations) {
    const title = issueTitle(v.branch, v.sha);
    if (open.has(title)) out.stillOpen.push(v);
    else if (closed.has(title)) out.acknowledged.push(v);
    else if (!queued.has(title)) {
      queued.add(title);
      out.toOpen.push({ title, violation: v });
    }
  }
  return out;
}

// Start time of the newest passing audit that ran this workflow as it is on
// the default branch, or null. A run dispatched on another branch or a tag
// runs that ref's copy of the script, which could pass without checking
// anything, so it does not count.
async function lastAuditStart(github, owner, repo, branch) {
  const { data } = await github.rest.actions.listWorkflowRuns({
    owner,
    repo,
    workflow_id: WORKFLOW_FILE,
    branch,
    status: 'success',
    per_page: 20,
  });
  const { data: tip } = await github.rest.repos.getBranch({ owner, repo, branch });
  for (const r of data.workflow_runs) {
    if (r.event !== 'schedule' && r.event !== 'workflow_dispatch') continue;
    if (r.head_branch !== branch) continue;
    let status;
    try {
      ({ data: { status } } = await github.rest.repos.compareCommitsWithBasehead({
        owner,
        repo,
        basehead: `${r.head_sha}...${tip.commit.sha}`,
        per_page: 1,
      }));
    } catch (err) {
      if (isNotFound(err)) continue;
      throw err;
    }
    if (status === 'ahead' || status === 'identical') return new Date(r.created_at);
  }
  return null;
}

function isNotFound(err) {
  return err?.status === 404;
}

// Newest first. Paging stops at the first page that reaches past the window,
// so a busy window is read in full and a quiet one costs one request.
async function branchActivity(github, owner, repo, branch, since, period) {
  const entries = await github.paginate(
    'GET /repos/{owner}/{repo}/activity',
    { owner, repo, ref: `refs/heads/${branch}`, direction: 'desc', time_period: period, per_page: 100 },
    (response, done) => {
      if (response.data.some((a) => Date.parse(a.timestamp) < since.getTime())) done();
      return response.data;
    },
  );
  return entries.filter((a) => Date.parse(a.timestamp) >= since.getTime());
}

async function mergedPullRequests(github, owner, repo, branch, cutoff) {
  // Sorted by last update, newest first. A pull request merged after the
  // cutoff was also updated after it, so paging can stop at the first older one.
  const pulls = await github.paginate(
    github.rest.pulls.list,
    { owner, repo, base: branch, state: 'closed', sort: 'updated', direction: 'desc', per_page: 100 },
    (response, done) => {
      if (response.data.some((p) => Date.parse(p.updated_at) < cutoff.getTime())) done();
      return response.data;
    },
  );
  return pulls
    .filter((p) => p.merged_at && Date.parse(p.merged_at) >= cutoff.getTime())
    .map((p) => ({ number: p.number, mergeCommitSha: p.merge_commit_sha, headSha: p.head.sha, commitShas: null }));
}

function apiLookups(github, owner, repo, branch, cutoff) {
  let merged = null;
  return {
    async findMergedPr(sha) {
      merged ??= await mergedPullRequests(github, owner, repo, branch, cutoff);
      return merged.find((p) => p.mergeCommitSha === sha) ?? null;
    },

    async compareRange(before, after) {
      // The compare API pages its commit list; read every page so a large
      // merge is checked in full.
      const commits = [];
      let status = 'unknown';
      for (let page = 1; ; page += 1) {
        const { data } = await github.rest.repos.compareCommitsWithBasehead({
          owner,
          repo,
          basehead: `${before}...${after}`,
          per_page: 100,
          page,
        });
        status = data.status;
        commits.push(...data.commits.map((c) => c.sha));
        if (data.commits.length < 100 || commits.length >= data.total_commits) break;
      }
      return { status, commits };
    },

    async prContains(pr, sha) {
      if (pr.commitShas === null) {
        const list = await github.paginate(github.rest.pulls.listCommits, {
          owner,
          repo,
          pull_number: pr.number,
          per_page: 100,
        });
        pr.commitShas = new Set(list.map((c) => c.sha));
        pr.truncated = list.length >= PR_COMMIT_LIST_LIMIT;
      }
      if (pr.commitShas.has(sha)) return true;
      if (!pr.truncated) return false;
      // The pull request commit list stops at 250. For larger ones, ask
      // whether the commit is an ancestor of the pull request's head instead.
      const { data } = await github.rest.repos.compareCommitsWithBasehead({
        owner,
        repo,
        basehead: `${sha}...${pr.headSha}`,
        per_page: 1,
      });
      return data.status === 'ahead' || data.status === 'identical';
    },

    async recomputeGate(pr, configRef) {
      try {
        const config = await loadConfig(github, owner, repo, configRef);
        const { data: full } = await github.rest.pulls.get({ owner, repo, pull_number: pr.number });
        const files = await changedFiles(github, owner, repo, pr.number, full.changed_files);
        const comments = await github.paginate(github.rest.issues.listComments, {
          owner,
          repo,
          issue_number: pr.number,
          per_page: 100,
        });
        // Only what was on the pull request when it merged counts.
        const mergedAt = Date.parse(full.merged_at);
        const before = comments.filter((c) => Date.parse(c.created_at) <= mergedAt);
        return evaluate({
          config,
          files,
          labels: (full.labels ?? []).map((l) => l.name),
          baseRef: branch,
          comments: before,
          headSha: full.head.sha,
        });
      } catch (err) {
        return { state: 'error', description: `could not re-check review: ${err.message}` };
      }
    },
  };
}

export default async function run({ github, context, core, now = new Date() }) {
  const { owner, repo } = context.repo;
  const { data: info } = await github.rest.repos.get({ owner, repo });
  if (!info.private) {
    core.info('Public repository: branch protection is enforced by GitHub, so there is nothing to audit.');
    return [];
  }

  const last = await lastAuditStart(github, owner, repo, info.default_branch);
  const since = windowStart(last, now);
  const period = activityPeriod(since, now);
  core.info(
    last
      ? `Auditing from ${since.toISOString()}, an hour before the last passing audit.`
      : `No passing audit found; auditing a full week from ${since.toISOString()}.`,
  );
  // A day of slack when looking up merged pull requests, in case the merge
  // timestamp and the activity timestamp straddle the window edge.
  const prCutoff = new Date(since.getTime() - DAY);
  const violations = [];

  for (const branch of BRANCHES) {
    const activities = await branchActivity(github, owner, repo, branch, since, period);
    core.info(`${branch}: ${activities.length} activity entries in the window`);
    const lookups = apiLookups(github, owner, repo, branch, prCutoff);
    violations.push(...(await auditBranch({ branch, activities, since, lookups })));
  }

  const issues = await github.paginate(github.rest.issues.listForRepo, {
    owner,
    repo,
    state: 'all',
    labels: LABEL,
    per_page: 100,
  });
  const { toOpen, acknowledged } = triage(
    violations,
    issues.filter((i) => !i.pull_request).map((i) => ({ title: i.title, state: i.state })),
  );
  if (toOpen.length > 0) {
    await ensureLabel(github, owner, repo);
  }
  const runUrl = `${context.serverUrl}/${owner}/${repo}/actions/runs/${context.runId}`;
  for (const { title, violation: v } of toOpen) {
    const body = [
      `The scheduled branch audit found a change on \`${v.branch}\` that did not go through the review flow.`,
      '',
      `- Commit: ${v.sha}`,
      `- Problem: ${v.reason}`,
      `- Audit run: ${runUrl}`,
      '',
      'Find out who made the change and why. If it was a mistake, revert it through a pull request.',
      'Close this issue once the branch is back to a reviewed state.',
    ].join('\n');
    await github.rest.issues.create({ owner, repo, title, body, labels: [LABEL] });
  }

  const closed = new Set(acknowledged);
  for (const v of violations) {
    const line = `${v.branch} ${v.sha.slice(0, 7)}: ${v.reason}`;
    if (closed.has(v)) core.info(`${line} (issue closed)`);
    else core.warning(line);
  }
  // The run fails while any finding is new or still open. Only a passing run
  // moves the next window forward.
  const unresolved = violations.length - acknowledged.length;
  if (unresolved > 0) {
    core.setFailed(`${unresolved} branch audit finding(s); ${toOpen.length} new issue(s) opened.`);
  } else if (violations.length > 0) {
    core.info('Every finding in the window already has a closed issue.');
  } else {
    core.info('Every change to the protected branches in the window arrived through a reviewed pull request.');
  }
  return violations;
}

async function ensureLabel(github, owner, repo) {
  try {
    await github.rest.issues.getLabel({ owner, repo, name: LABEL });
  } catch (err) {
    if (!isNotFound(err)) throw err;
    await github.rest.issues.createLabel({
      owner,
      repo,
      name: LABEL,
      color: 'b60205',
      description: 'A protected branch changed outside the review flow',
    });
  }
}
