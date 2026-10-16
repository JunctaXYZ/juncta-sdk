// Computes the review-gate commit status for one pull request.
//
// The gate passes only when every reviewer the change requires has posted an
// approval marker for the exact head SHA, and no reviewer's latest marker asks
// for changes. The required set comes from .github/review-gate.json on the
// base branch, so a pull request cannot loosen its own requirements.
//
// Everything except run() is pure, so the rules can be tested without the API.

export const STATUS_CONTEXT = 'review-gate';
export const CONFIG_PATH = '.github/review-gate.json';

// A marker must be the whole line. Anything around it (quoting, indentation,
// a trailing word) means it does not count.
export const MARKER_RE =
  /^<!-- juncta-review reviewer=([a-z-]+) sha=([0-9a-f]{40}) verdict=(approve|changes_requested) -->$/;

// Markers are a process control, not authentication. Limiting them to people
// with a standing relationship to the repo keeps drive-by commenters out.
export const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

const NAME_RE = /^[a-z-]+$/;
const DESCRIPTION_LIMIT = 140;

// Converts a path glob to an anchored RegExp.
//   **   any number of path segments, including none, when it is a whole segment
//   *    any run of characters except "/"
//   ?    one character except "/"
// Dotfiles match like any other name. Brackets and braces are literal, which
// keeps the rules easy to read: list alternatives as separate globs.
export function globToRegExp(glob) {
  let out = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      const segmentStart = i === 0 || glob[i - 1] === '/';
      const atEnd = i + 2 === glob.length;
      const segmentEnd = atEnd || glob[i + 2] === '/';
      if (segmentStart && segmentEnd) {
        if (atEnd) {
          out += '.*';
          i += 2;
        } else {
          out += '(?:.*/)?';
          i += 3;
        }
        continue;
      }
      // "a**b" has no sensible directory meaning; treat it as a single "*".
      out += '[^/]*';
      i += 2;
      continue;
    }
    if (c === '*') {
      out += '[^/]*';
    } else if (c === '?') {
      out += '[^/]';
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    i += 1;
  }
  return new RegExp(`^${out}$`);
}

export function matchesAny(path, globs) {
  return globs.some((g) => globToRegExp(g).test(path));
}

function assertNames(value, where) {
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string' && NAME_RE.test(v))) {
    throw new Error(`${where} must be a list of lowercase reviewer names`);
  }
}

function assertStrings(value, where) {
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string' && v.length > 0)) {
    throw new Error(`${where} must be a list of non-empty strings`);
  }
}

// Rejects anything unexpected rather than guessing. A typo in the map should
// fail the gate loudly, not silently drop a reviewer.
export function validateConfig(config) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('config must be a JSON object');
  }
  for (const key of Object.keys(config)) {
    if (!['always', 'rules', 'hotfix'].includes(key)) {
      throw new Error(`unknown config key "${key}"`);
    }
  }
  assertNames(config.always, 'always');
  if (config.always.length === 0) {
    throw new Error('always must name at least one reviewer');
  }
  const rules = config.rules ?? [];
  if (!Array.isArray(rules)) {
    throw new Error('rules must be a list');
  }
  rules.forEach((rule, n) => {
    const where = `rules[${n}]`;
    if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) {
      throw new Error(`${where} must be an object`);
    }
    for (const key of Object.keys(rule)) {
      if (!['paths', 'labels', 'require'].includes(key)) {
        throw new Error(`${where} has unknown key "${key}"`);
      }
    }
    const paths = rule.paths ?? [];
    const labels = rule.labels ?? [];
    assertStrings(paths, `${where}.paths`);
    assertStrings(labels, `${where}.labels`);
    if (paths.length === 0 && labels.length === 0) {
      throw new Error(`${where} needs paths or labels`);
    }
    assertNames(rule.require, `${where}.require`);
    if (rule.require.length === 0) {
      throw new Error(`${where}.require must name at least one reviewer`);
    }
  });
  if (config.hotfix !== undefined) {
    const h = config.hotfix;
    if (h === null || typeof h !== 'object' || typeof h.base !== 'string' || h.base === '') {
      throw new Error('hotfix.base must be a branch name');
    }
    for (const key of Object.keys(h)) {
      if (!['base', 'require'].includes(key)) {
        throw new Error(`hotfix has unknown key "${key}"`);
      }
    }
    assertNames(h.require, 'hotfix.require');
  }
  return config;
}

// files: every path the pull request touches, including the old name of a
// renamed file, so moving code out of a sensitive directory still needs the
// reviewers that directory requires.
export function requiredReviewers(config, { files, labels, baseRef }) {
  const required = new Set(config.always);
  for (const rule of config.rules ?? []) {
    const byPath = files.some((f) => matchesAny(f, rule.paths ?? []));
    const byLabel = (rule.labels ?? []).some((l) => labels.includes(l));
    if (byPath || byLabel) {
      rule.require.forEach((r) => required.add(r));
    }
  }
  if (config.hotfix && baseRef === config.hotfix.base) {
    config.hotfix.require.forEach((r) => required.add(r));
  }
  return [...required].sort();
}

export function parseMarkers(body) {
  const markers = [];
  for (const raw of String(body ?? '').split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const m = MARKER_RE.exec(line);
    if (m) {
      markers.push({ reviewer: m[1], sha: m[2], verdict: m[3] });
    }
  }
  return markers;
}

// Returns the latest counting verdict per reviewer, plus the reasons other
// markers were ignored (useful in the run log when a gate looks wrong).
export function latestVerdicts(comments, headSha) {
  const ordered = [...comments].sort((a, b) => {
    const t = Date.parse(a.created_at) - Date.parse(b.created_at);
    return t !== 0 ? t : a.id - b.id;
  });
  const verdicts = new Map();
  const ignored = [];
  for (const c of ordered) {
    const markers = parseMarkers(c.body);
    if (markers.length === 0) continue;
    const who = c.user?.login ?? 'unknown';
    if (!TRUSTED_ASSOCIATIONS.has(c.author_association)) {
      ignored.push({ id: c.id, reason: `author ${who} is ${c.author_association}` });
      continue;
    }
    // An edited comment could have had its SHA or verdict swapped after the
    // review ran, so it never counts. Post a new comment instead.
    if (c.updated_at !== c.created_at) {
      ignored.push({ id: c.id, reason: 'comment was edited' });
      continue;
    }
    for (const m of markers) {
      if (m.sha !== headSha) {
        ignored.push({ id: c.id, reason: `${m.reviewer} marker is for ${m.sha.slice(0, 7)}` });
        continue;
      }
      verdicts.set(m.reviewer, { verdict: m.verdict, commentId: c.id });
    }
  }
  return { verdicts, ignored };
}

function clip(text) {
  return text.length <= DESCRIPTION_LIMIT ? text : `${text.slice(0, DESCRIPTION_LIMIT - 3)}...`;
}

export function evaluate({ config, files, labels, baseRef, comments, headSha }) {
  const required = requiredReviewers(config, { files, labels, baseRef });
  const { verdicts, ignored } = latestVerdicts(comments, headSha);
  // Any reviewer asking for changes blocks, required or not: someone added
  // "when in doubt" still found a problem.
  const rejected = [...verdicts]
    .filter(([, v]) => v.verdict === 'changes_requested')
    .map(([name]) => name)
    .sort();
  const missing = required.filter((r) => verdicts.get(r)?.verdict !== 'approve');
  const short = headSha.slice(0, 7);
  let state = 'success';
  let description = `${required.length} required approvals present for ${short}`;
  if (rejected.length > 0 || missing.length > 0) {
    state = 'failure';
    const parts = [];
    if (rejected.length > 0) parts.push(`changes requested: ${rejected.join(', ')}`);
    const waiting = missing.filter((m) => !rejected.includes(m));
    if (waiting.length > 0) parts.push(`missing: ${waiting.join(', ')}`);
    description = parts.join('; ');
  }
  return { state, description: clip(description), required, missing, rejected, ignored };
}

export async function loadConfig(github, owner, repo, ref) {
  let data;
  try {
    ({ data } = await github.rest.repos.getContent({ owner, repo, path: CONFIG_PATH, ref }));
  } catch (err) {
    if (err.status === 404) throw new Error(`${CONFIG_PATH} not found on ${ref}`);
    throw err;
  }
  if (Array.isArray(data) || data.type !== 'file' || typeof data.content !== 'string') {
    throw new Error(`${CONFIG_PATH} on ${ref} is not a file`);
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
  } catch {
    throw new Error(`${CONFIG_PATH} on ${ref} is not valid JSON`);
  }
  return validateConfig(parsed);
}

export async function changedFiles(github, owner, repo, number, expected) {
  const entries = await github.paginate(github.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: number,
    per_page: 100,
  });
  // The files API stops at 3000 entries. Fail closed rather than evaluate a
  // partial list that might miss a sensitive path.
  if (entries.length < expected) {
    throw new Error(`only ${entries.length} of ${expected} changed files are visible`);
  }
  const paths = new Set();
  for (const e of entries) {
    paths.add(e.filename);
    if (e.previous_filename) paths.add(e.previous_filename);
  }
  return [...paths];
}

export default async function run({ github, context, core }) {
  const { owner, repo } = context.repo;
  const number = context.payload.pull_request?.number ?? context.payload.issue?.number;
  if (!number) {
    core.info('Event is not tied to a pull request; nothing to do.');
    return null;
  }
  // Read the pull request fresh. The event payload can be stale when several
  // events arrive close together.
  const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: number });
  if (pr.state !== 'open') {
    core.info(`Pull request #${number} is ${pr.state}; leaving its status alone.`);
    return null;
  }
  const headSha = pr.head.sha;
  let result;
  try {
    const config = await loadConfig(github, owner, repo, pr.base.ref);
    const files = await changedFiles(github, owner, repo, number, pr.changed_files);
    const comments = await github.paginate(github.rest.issues.listComments, {
      owner,
      repo,
      issue_number: number,
      per_page: 100,
    });
    result = evaluate({
      config,
      files,
      labels: (pr.labels ?? []).map((l) => l.name),
      baseRef: pr.base.ref,
      comments,
      headSha,
    });
  } catch (err) {
    // "error" rather than "failure" so a broken config is not mistaken for a
    // missing review. Both block the merge.
    result = {
      state: 'error',
      description: clip(`gate error: ${err.message}`),
      required: [],
      missing: [],
      rejected: [],
      ignored: [],
    };
  }

  await github.rest.repos.createCommitStatus({
    owner,
    repo,
    sha: headSha,
    state: result.state,
    context: STATUS_CONTEXT,
    description: result.description,
    target_url: `${context.serverUrl}/${owner}/${repo}/actions/runs/${context.runId}`,
  });

  core.info(`#${number} at ${headSha}: ${result.state} (${result.description})`);
  core.info(`required: ${result.required.join(', ') || 'none'}`);
  for (const i of result.ignored) {
    core.info(`ignored comment ${i.id}: ${i.reason}`);
  }
  return result;
}
