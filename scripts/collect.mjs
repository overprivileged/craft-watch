// Collects public GitHub activity for the apps in repos.json.
// Keeps per-repo state in data/state.json (cached between runs) and writes the summary to data/apps.json.
// Each run asks GitHub only for PRs and issues updated since the last run. Needs GITHUB_TOKEN; never prints it.
import { readFile, writeFile, mkdir, stat, rename } from 'node:fs/promises';
import { readCommitHistory } from './commit-history.mjs';

const ROOT = new URL('../', import.meta.url);
const WINDOW_DAYS = 30;
const PAGE_SIZE = 50;
const MAX_PAGES = 6; // newest 300 PRs and 300 issues per repo; anything older is flagged as truncated
const RELEASE_KEEP_DAYS = 120; // releases listed for the version picker and maps; counts still use the 30-day window
// Backfill: PRs and issues the newest-first walk could not reach (a first full fetch, or a run with more than 300 updates)
// are read later through search, one time slice at a time, a few calls per repo per run, until the gap is closed.
const BACKFILL_CALLS = Number(process.env.BACKFILL_CALLS ?? 30);
const SEARCH_CAP = 1000; // GitHub search returns at most 1000 results per query; bigger slices are split
const CURSOR_MARGIN_MS = 5 * 60e3; // re-read a little before the last run to cover clock skew
const DEPENDENCY_FILES = new Set([
  'Cargo.toml', 'Cargo.lock', 'package.json', 'package-lock.json', 'pnpm-lock.yaml',
  'yarn.lock', 'requirements.txt', 'go.mod', 'go.sum',
]);
const AI_COAUTHOR = /^Co-authored-by:.*\b(claude|copilot|cursor|codex|gemini|chatgpt|openai|anthropic)\b/im;

const token = process.env.GITHUB_TOKEN;
if (!token) {
  console.error('GITHUB_TOKEN is not set. Export it in your shell and run again.');
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'craft-watch',
};
const runStart = Date.now();
const windowStart = runStart - WINDOW_DAYS * 864e5;
const sinceIso = new Date(windowStart).toISOString();
const inWindow = (iso) => Boolean(iso) && Date.parse(iso) >= windowStart;

const SUMMARY_QUERY = `query($owner: String!, $name: String!, $since: GitTimestamp!) {
  rateLimit { remaining }
  repository(owner: $owner, name: $name) {
    isArchived
    defaultBranchRef {
      name
      target {
        ... on Commit {
          history(first: 100, since: $since) {
            totalCount
            nodes { message committedDate }
          }
        }
      }
    }
    openPulls: pullRequests(states: [OPEN]) { totalCount }
    openIssues: issues(states: [OPEN]) { totalCount }
    closedIssues: issues(states: [CLOSED]) { totalCount }
  }
}`;

// Counts only: commits on the default branch since a date, with no commit details.
// Light records for the backfill: no files and no check runs (those are filled in when the item is next updated).
const SEARCH_QUERY = `query($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: 100, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes {
      __typename
      ... on PullRequest {
        number title state isDraft createdAt updatedAt mergedAt closedAt reviewDecision url
        author { __typename login }
        mergedBy { login }
        reviews(states: APPROVED) { totalCount }
        labels(first: 10) { nodes { name } }
      }
      ... on Issue {
        number title state createdAt updatedAt closedAt url
        author { login }
        labels(first: 10) { nodes { name } }
        reactions(content: THUMBS_UP) { totalCount }
      }
    }
  }
}`;

const COMMITS_SINCE_QUERY = `query($owner: String!, $name: String!, $since: GitTimestamp!) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef {
      target {
        ... on Commit {
          history(first: 1, since: $since) { totalCount }
        }
      }
    }
  }
}`;

const PULLS_QUERY = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: ${PAGE_SIZE}, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }, states: [OPEN, MERGED, CLOSED]) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title state isDraft createdAt updatedAt mergedAt closedAt reviewDecision url
        author { __typename login }
        mergedBy { login }
        reviews(states: APPROVED) { totalCount }
        labels(first: 10) { nodes { name } }
        files(first: 100) { nodes { path } }
        commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { totalCount nodes { __typename ... on CheckRun { name conclusion startedAt } ... on StatusContext { context state createdAt } } } } } } }
      }
    }
  }
}`;

const ISSUES_QUERY = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    issues(first: ${PAGE_SIZE}, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }, states: [OPEN, CLOSED]) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title state createdAt updatedAt closedAt url
        author { login }
        labels(first: 10) { nodes { name } }
        reactions(content: THUMBS_UP) { totalCount }
      }
    }
  }
}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// GitHub's GraphQL endpoint sometimes returns 502/504 or a cut-off body; retry those a few times.
async function withRetry(label, attempt) {
  for (let i = 1; ; i++) {
    try {
      return await attempt();
    } catch (error) {
      if (i >= 4 || !error.retryable) throw new Error(`${label}: ${error.message}`);
      await sleep(2000 * i);
    }
  }
}

async function graphql(query, variables) {
  return withRetry('GraphQL', async () => {
    const res = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { retryable: res.status >= 500 });
    let body;
    try {
      body = await res.json();
    } catch {
      throw Object.assign(new Error('response was cut off'), { retryable: true });
    }
    if (body.errors) throw new Error(body.errors.map((e) => e.message).join('; '));
    return body.data;
  });
}

async function rest(path) {
  const res = await fetch(`https://api.github.com${path}`, { headers });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`REST ${path.split('?')[0]} HTTP ${res.status}`);
  return res.json();
}

async function scorecard(owner, name) {
  const res = await fetch(`https://api.securityscorecards.dev/projects/github.com/${owner}/${name}`);
  if (!res.ok) return null;
  const body = await res.json();
  return { score: body.score, date: body.date };
}

// Walks newest-first pages and stops at the first item older than stopAt (already known from earlier runs).
async function fetchNewer(owner, name, query, field, stopAt) {
  const nodes = [];
  let after = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await graphql(query, { owner, name, after });
    const connection = data.repository[field];
    const fresh = connection.nodes.filter((n) => Date.parse(n.updatedAt) >= stopAt);
    nodes.push(...fresh);
    if (!connection.pageInfo.hasNextPage || fresh.length < connection.nodes.length) {
      return { nodes, truncated: false };
    }
    after = connection.pageInfo.endCursor;
  }
  return { nodes, truncated: true };
}

// Terms that make a change security-related, matched on the title and labels only.
const SECURITY_TERMS = /RUSTSEC|CVE|GHSA|security|vulnerab|hostile|high-severity/i;

const checkName = (run) => run.name ?? run.context ?? '';
const checkOutcome = (run) => run.conclusion ?? run.state ?? null;
const checkTime = (run) => Date.parse(run.startedAt ?? run.createdAt ?? 0);

// True when a check failed and later the same check passed on a rerun.
function sawRetry(runs) {
  const byName = new Map();
  for (const run of runs) byName.set(checkName(run), [...(byName.get(checkName(run)) ?? []), run]);
  return [...byName.values()].some((list) => {
    list.sort((a, b) => checkTime(a) - checkTime(b));
    const failed = list.findIndex((run) => ['FAILURE', 'ERROR'].includes(checkOutcome(run)));
    return failed >= 0 && list.slice(failed + 1).some((run) => checkOutcome(run) === 'SUCCESS');
  });
}

function pullRecord(n) {
  if (!n.files) return lightPullRecord(n);
  const paths = n.files.nodes.map((f) => f.path);
  return {
    number: n.number,
    title: n.title,
    state: n.state,
    is_draft: n.isDraft,
    url: n.url,
    author: n.author?.login ?? null,
    author_type: n.author?.__typename ?? null,
    created_at: n.createdAt,
    updated_at: n.updatedAt,
    merged_at: n.mergedAt,
    closed_at: n.closedAt,
    review_decision: n.reviewDecision,
    labels: n.labels.nodes.map((l) => l.name),
    checks: n.commits.nodes[0]?.commit.statusCheckRollup?.state ?? null,
    checks_total: n.commits.nodes[0]?.commit.statusCheckRollup?.contexts.totalCount ?? 0,
    checks_passed: (() => {
      const runs = n.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? [];
      const total = n.commits.nodes[0]?.commit.statusCheckRollup?.contexts.totalCount ?? 0;
      return total <= runs.length ? runs.filter((run) => checkOutcome(run) === 'SUCCESS').length : null;
    })(),
    checks_retried: sawRetry(n.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? []),
    approvals: n.reviews.totalCount,
    merged_by: n.mergedBy?.login ?? null,
    security_terms: SECURITY_TERMS.test([n.title, ...n.labels.nodes.map((l) => l.name)].join(" ")),
    workflow_touched: paths.some((p) => p.startsWith('.github/workflows/')),
    dependency_touched: paths.some((p) => DEPENDENCY_FILES.has(p.split('/').pop())),
  };
}

// A PR read by the backfill: checks and touched files are unknown (null), never guessed.
function lightPullRecord(n) {
  return {
    number: n.number,
    title: n.title,
    state: n.state,
    is_draft: n.isDraft,
    url: n.url,
    author: n.author?.login ?? null,
    author_type: n.author?.__typename ?? null,
    created_at: n.createdAt,
    updated_at: n.updatedAt,
    merged_at: n.mergedAt,
    closed_at: n.closedAt,
    review_decision: n.reviewDecision,
    labels: n.labels.nodes.map((l) => l.name),
    checks: null,
    checks_total: null,
    checks_passed: null,
    checks_retried: false,
    approvals: n.reviews.totalCount,
    merged_by: n.mergedBy?.login ?? null,
    security_terms: SECURITY_TERMS.test([n.title, ...n.labels.nodes.map((l) => l.name)].join(' ')),
    workflow_touched: null,
    dependency_touched: null,
    light: true,
  };
}

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

// Gaps are [fromMs, toMs] ranges of updated_at that we have not read yet. Kept sorted, inside the window, no empty ones.
function cleanGaps(gaps) {
  return (gaps ?? [])
    .map(([a, b]) => [Math.max(a, windowStart), b])
    .filter(([a, b]) => b - a > 1000)
    .sort((x, y) => y[1] - x[1]);
}

// Fills gaps newest first (recent days matter most), one slice per search. Stops at the call budget or on any error.
// Returns the gaps still open.
async function backfill(owner, name, kind, gaps, store, record, budget) {
  const type = kind === 'pulls' ? 'pr' : 'issue';
  let open = cleanGaps(gaps);
  while (open.length && budget.calls > 0) {
    const [from, to] = open[0];
    let sliceFrom = Math.max(from, to - 24 * 3600e3);
    let after = null;
    let done = false;
    while (!done && budget.calls > 0) {
      const q = `repo:${owner}/${name} is:${type} updated:${iso(sliceFrom)}..${iso(to)}`;
      budget.calls -= 1;
      const result = (await graphql(SEARCH_QUERY, { q, after })).search;
      if (after === null && result.issueCount > SEARCH_CAP && to - sliceFrom > 60e3) {
        sliceFrom = to - (to - sliceFrom) / 2; // too many for one search: halve the slice and try again
        continue;
      }
      for (const node of result.nodes) {
        if (!node || !node.number) continue;
        const known = store[node.number];
        if (!known || Date.parse(known.updated_at) < Date.parse(node.updatedAt)) store[node.number] = record(node);
      }
      if (result.pageInfo.hasNextPage) after = result.pageInfo.endCursor;
      else done = true;
    }
    if (!done) break; // budget ran out mid-slice: the same slice is read again next run
    open[0] = [from, sliceFrom];
    open = cleanGaps(open);
  }
  return open;
}

function issueRecord(n) {
  return {
    number: n.number,
    title: n.title,
    state: n.state,
    url: n.url,
    author: n.author?.login ?? null,
    created_at: n.createdAt,
    updated_at: n.updatedAt,
    closed_at: n.closedAt,
    labels: n.labels.nodes.map((l) => l.name),
    thumbs_up: n.reactions.totalCount,
  };
}

function countBy(items, key) {
  const out = {};
  for (const item of items) {
    const value = key(item) ?? 'NONE';
    out[value] = (out[value] ?? 0) + 1;
  }
  return out;
}

async function collectApp(app, previous, runCursor) {
  const [owner, name] = app.repo.split('/');
  const cursorMs = previous?.cursor ? Date.parse(previous.cursor) : 0;
  const stopAt = Math.max(cursorMs, windowStart);

  const summary = await graphql(SUMMARY_QUERY, { owner, name, since: sinceIso });
  const repo = summary.repository;
  if (!repo) throw new Error('repository not found or not visible');

  const pulls = await fetchNewer(owner, name, PULLS_QUERY, 'pullRequests', stopAt);
  const issues = await fetchNewer(owner, name, ISSUES_QUERY, 'issues', stopAt);

  // What the newest-first walk could not reach becomes a gap. State saved before backfill existed is re-read once
  // over the whole window, because earlier runs may have left holes we cannot see.
  const oldestUpdate = (nodes, fallback) => (nodes.length ? Math.min(...nodes.map((n) => Date.parse(n.updatedAt))) : fallback);
  const startGaps = (kind, walk) => {
    const gaps = previous?.gaps?.[kind] ? previous.gaps[kind].map(([a, b]) => [a, b]) : null;
    const list = gaps ?? (previous ? [[windowStart, runStart]] : []);
    if (walk.truncated) list.push([stopAt, oldestUpdate(walk.nodes, runStart)]);
    return list;
  };
  const gapsIn = { pulls: startGaps('pulls', pulls), issues: startGaps('issues', issues) };

  // Keep what we already had, add or replace what changed, then drop anything older than the window.
  const prs = { ...previous?.prs };
  for (const node of pulls.nodes) prs[node.number] = pullRecord(node);
  const iss = { ...previous?.issues };
  for (const node of issues.nodes) iss[node.number] = issueRecord(node);

  // Backfill: shares one call budget per repo. A failure leaves the gaps for the next run and never fails the app.
  const budget = { calls: previous ? BACKFILL_CALLS : BACKFILL_CALLS * 2 };
  const gapsOut = { pulls: cleanGaps(gapsIn.pulls), issues: cleanGaps(gapsIn.issues) };
  try {
    gapsOut.pulls = await backfill(owner, name, 'pulls', gapsIn.pulls, prs, pullRecord, budget);
    gapsOut.issues = await backfill(owner, name, 'issues', gapsIn.issues, iss, issueRecord, budget);
  } catch (error) {
    console.log(`note  ${app.repo}: backfill paused (${error.message})`);
  }
  for (const [number, pr] of Object.entries(prs)) if (!inWindow(pr.updated_at)) delete prs[number];
  for (const [number, issue] of Object.entries(iss)) if (!inWindow(issue.updated_at)) delete iss[number];
  // Data is complete from the newest gap's end onwards; with no gaps, for the whole window.
  const completeFrom = (gaps) => iso(gaps.length ? Math.max(...gaps.map(([, b]) => b)) : windowStart);

  const history = repo.defaultBranchRef?.target?.history;
  const commitMessages = history?.nodes.map((n) => n.message) ?? [];
  let commitTimes = history?.nodes.map((n) => n.committedDate) ?? [];
  let commitTotal = history?.totalCount ?? 0;
  let commitsTruncated = commitTotal > commitTimes.length;
  if (commitsTruncated && repo.defaultBranchRef?.name) {
    try {
      const paged = await readCommitHistory(graphql, {
        owner, name, branch: repo.defaultBranchRef.name, since: sinceIso, until: new Date(runStart).toISOString(),
      });
      commitTimes = paged.times;
      commitTotal = paged.total;
      commitsTruncated = paged.truncated;
    } catch (error) {
      console.log(`note  ${app.repo}: commit history pagination unavailable (${error.message}); latest timestamps retained`);
    }
  }
  const aiTagged = commitMessages.filter((m) => AI_COAUTHOR.test(m)).length;

  const prList = Object.values(prs);
  const issueList = Object.values(iss);
  const prsOpened = prList.filter((p) => inWindow(p.created_at));
  const issuesOpened = issueList.filter((i) => inWindow(i.created_at));

  const releases = (await rest(`/repos/${owner}/${name}/releases?per_page=100`)) ?? [];
  const releasesInWindow = releases.filter((r) => !r.draft && inWindow(r.published_at));
  const keepFrom = runStart - RELEASE_KEEP_DAYS * 864e5;
  const releasesKept = releases.filter((r) => !r.draft && r.published_at && Date.parse(r.published_at) >= keepFrom);
  // Day one comes from repos.json when set, so the headline never moves when the window does.
  const keptFirst = releasesKept.length ? Math.min(...releasesKept.map((r) => Date.parse(r.published_at))) : null;
  const firstReleaseMs = app.day_one ? Date.parse(app.day_one) : keptFirst;
  const commitsSinceFirst = firstReleaseMs === null
    ? null
    : (await graphql(COMMITS_SINCE_QUERY, { owner, name, since: new Date(firstReleaseMs).toISOString() }))
      .repository?.defaultBranchRef?.target?.history?.totalCount ?? null;
  const latest = releases.find((r) => !r.draft) ?? null;
  // The latest release is always listed, even when it is older than the kept range.
  if (latest && !releasesKept.includes(latest)) releasesKept.push(latest);
  // Exact commits in the last 24 hours, even when timestamp collection is capped or fails.
  const commits24h = (await graphql(COMMITS_SINCE_QUERY, { owner, name, since: new Date(runStart - 24 * 3600e3).toISOString() }))
    .repository?.defaultBranchRef?.target?.history?.totalCount ?? null;

  const advisories = await rest(`/repos/${owner}/${name}/security-advisories?per_page=100`);
  const advisoriesInWindow = (advisories ?? []).filter((a) => inWindow(a.published_at));

  const output = {
    name: app.name,
    repo: app.repo,
    colour: app.colour,
    ok: true,
    collected_at: new Date(runStart).toISOString(),
    archived: repo.isArchived,
    default_branch: repo.defaultBranchRef?.name ?? null,
    truncated: {
      commits: commitsTruncated,
      pulls: pulls.truncated,
      issues: issues.truncated,
    },
    // PRs and issues are complete from these times on; earlier days are still being filled in when they are later than the window start.
    coverage: {
      window_start: iso(windowStart),
      pulls_complete_from: completeFrom(gapsOut.pulls),
      issues_complete_from: completeFrom(gapsOut.issues),
    },
    commits: {
      total: commitTotal,
      last_24h: commits24h,
      ai_tagged: aiTagged,
      ai_tagged_pct: commitMessages.length ? Math.round((aiTagged / commitMessages.length) * 100) : null,
    },
    pulls: {
      opened: prsOpened.length,
      merged: prList.filter((p) => inWindow(p.merged_at)).length,
      closed_unmerged: prList.filter((p) => inWindow(p.closed_at) && !p.merged_at).length,
      open_now: repo.openPulls.totalCount,
      checks_open: countBy(prList.filter((p) => p.state === 'OPEN'), (p) => p.checks),
      workflows_touched: prsOpened.filter((p) => p.workflow_touched).length,
      dependencies_touched: prsOpened.filter((p) => p.dependency_touched).length,
    },
    issues: {
      opened: issuesOpened.length,
      closed: issueList.filter((i) => inWindow(i.closed_at)).length,
      open_now: repo.openIssues.totalCount,
      closed_total: repo.closedIssues.totalCount,
    },
    releases: {
      in_window: releasesInWindow.length,
      latest: latest && {
        tag: latest.tag_name,
        published_at: latest.published_at,
        assets: latest.assets.length,
        has_checksums: latest.assets.some((a) => /sha256|checksum/i.test(a.name)),
      },
    },
    advisories: advisories === null
      ? null
      : {
        in_window: advisoriesInWindow.length,
        items: advisoriesInWindow.map((a) => ({
          ghsa: a.ghsa_id,
          cve: a.cve_id,
          severity: a.severity,
          published_at: a.published_at,
          summary: a.summary,
          patched: a.vulnerabilities?.map((v) => v.first_patched_version?.identifier).filter(Boolean) ?? [],
          packages: a.vulnerabilities?.map((v) => v.package?.name).filter(Boolean) ?? [],
        })),
      },
    // Commits since this app's first release in the data, for the landing headline.
    first_release_at: firstReleaseMs === null ? null : new Date(firstReleaseMs).toISOString(),
    commits_since_first_release: commitsSinceFirst,
    // Recent events for the space view: timestamps and short fields only.
    commit_times: commitTimes,
    pulls_recent: prList.filter((p) => inWindow(p.updated_at)).map((p) => ({
      number: p.number,
      title: p.title,
      state: p.state,
      url: p.url,
      author: p.author,
      author_type: p.author_type,
      is_draft: p.is_draft,
      review_decision: p.review_decision,
      labels: p.labels,
      workflow_touched: p.workflow_touched,
      dependency_touched: p.dependency_touched,
      created_at: p.created_at,
      merged_at: p.merged_at,
      closed_at: p.closed_at,
      checks: p.checks,
      checks_total: p.checks_total,
      checks_passed: p.checks_passed,
      checks_retried: p.checks_retried,
      approvals: p.approvals,
      merged_by: p.merged_by,
      security_terms: p.security_terms,
      ...(p.light ? { light: true } : {}),
    })),
    // Issues in the window, for "problems reported" and "fixed" this week.
    issues_recent: Object.values(iss).map((i) => ({
      number: i.number,
      title: i.title,
      state: i.state,
      created_at: i.created_at,
      closed_at: i.closed_at,
    })),
    releases_recent: releasesKept.map((r) => ({
      tag: r.tag_name,
      published_at: r.published_at,
      url: r.html_url,
      has_checksums: r.assets.some((a) => /sha256|checksum/i.test(a.name)),
    })),
    scorecard: await scorecard(owner, name),
  };

  return {
    output,
    rateLimit: summary.rateLimit.remaining,
    repoState: { cursor: runCursor, prs, issues: iss, gaps: gapsOut, last_good: output },
  };
}

// The entry kept for an app whose refresh failed: its previous data, marked stale since its last good refresh.
function staleEntry(app, error, previous) {
  const nowIso = new Date(runStart).toISOString();
  return {
    ...(previous ?? {}),
    name: app.name,
    repo: app.repo,
    colour: app.colour,
    ok: false,
    error,
    failed_at: nowIso,
    stale_since: previous?.stale_since ?? previous?.collected_at ?? nowIso,
  };
}

function row(app) {
  const pct = (v) => (v === null || v === undefined ? '—' : `${v}%`);
  const checks = app.pulls.checks_open ?? {};
  const failing = (checks.FAILURE ?? 0) + (checks.ERROR ?? 0);
  return {
    app: app.name,
    commits_30d: app.commits.total,
    ai_tagged: pct(app.commits.ai_tagged_pct),
    prs_opened: app.pulls.opened,
    prs_merged: app.pulls.merged,
    prs_closed: app.pulls.closed_unmerged,
    prs_open: app.pulls.open_now,
    checks_failing: failing,
    issues_opened: app.issues.opened,
    issues_closed: app.issues.closed,
    issues_open: app.issues.open_now,
    releases_30d: app.releases.in_window,
    latest: app.releases.latest?.tag ?? 'none found',
    advisories_30d: app.advisories ? app.advisories.in_window : 'n/a',
    scorecard: app.scorecard?.score ?? 'none found',
    workflows: app.pulls.workflows_touched,
    deps: app.pulls.dependencies_touched,
    truncated: Object.keys(app.truncated).filter((k) => app.truncated[k]).join(',') || '-',
  };
}

const exists = (path) => stat(path).then(() => true, () => false);
const readJson = async (path, fallback) => (await exists(path))
  ? JSON.parse(await readFile(path, 'utf8'))
  : fallback;

const apps = JSON.parse(await readFile(new URL('repos.json', ROOT), 'utf8')).apps;
const statePath = new URL('data/state.json', ROOT);
const outPath = new URL('data/apps.json', ROOT);
const tmpPath = new URL('data/apps.json.tmp', ROOT);
const previousApps = new Map((await readJson(outPath, { apps: [] })).apps.map((a) => [a.repo, a]));
const STATE_VERSION = 3;
const saved = await readJson(statePath, null);
const state = saved?.version === STATE_VERSION ? saved : { version: STATE_VERSION, repos: {} };
const runCursor = new Date(runStart - CURSOR_MARGIN_MS).toISOString();

// Saves are queued so two repos finishing at once never write the file at the same time.
let saving = Promise.resolve();
const saveState = () => {
  saving = saving.then(() => writeFile(statePath, JSON.stringify(state) + '\n'));
  return saving;
};

// Runs fn over items with at most `limit` in flight. Results keep the input order.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  }));
  return results;
}

let rateLimit = null;
await mkdir(new URL('data/history/', ROOT), { recursive: true });
const results = await mapLimit(apps, 4, async (app) => {
  try {
    const { output, rateLimit: remaining, repoState } = await collectApp(app, state.repos[app.repo], runCursor);
    rateLimit = remaining;
    state.repos[app.repo] = repoState;
    console.log(`ok    ${app.repo}`);
    return output;
  } catch (error) {
    console.log(`FAIL  ${app.repo}: ${error.message}`);
    return staleEntry(app, error.message, previousApps.get(app.repo) ?? state.repos[app.repo]?.last_good ?? null);
  } finally {
    // Save after every repo so a timeout later in the run keeps this progress.
    await saveState();
  }
});

const succeeded = results.filter((r) => r.ok).length;
const enoughToPublish = succeeded * 2 >= results.length;
if (enoughToPublish) {
  await writeFile(tmpPath, JSON.stringify({
    generated_at: new Date(runStart).toISOString(),
    window_days: WINDOW_DAYS,
    graphql_rate_limit_remaining: rateLimit,
    apps: results,
  }) + '\n');
  await rename(tmpPath, outPath);
} else {
  console.error(`Only ${succeeded} of ${results.length} apps refreshed. apps.json was not replaced; the previous data stays.`);
  process.exitCode = 1;
}

// One small snapshot per day: the first run of the UTC day writes it, later runs leave it alone.
const today = new Date(runStart).toISOString().slice(0, 10);
const historyPath = new URL(`data/history/${today}.json`, ROOT);
if (enoughToPublish && !(await exists(historyPath))) {
  const snapshot = results.map((a) => (a.ok
    ? {
      repo: a.repo,
      ok: true,
      commits_30d: a.commits.total,
      prs_open: a.pulls.open_now,
      issues_open: a.issues.open_now,
      releases_30d: a.releases.in_window,
      latest: a.releases.latest?.tag ?? null,
    }
    : { repo: a.repo, ok: false, error: a.error }));
  await writeFile(historyPath, JSON.stringify({ date: today, apps: snapshot }, null, 2) + '\n');
  console.log(`history: wrote data/history/${today}.json`);
}

console.log('');
console.table(results.filter((r) => r.ok).map(row));
const failures = results.filter((r) => !r.ok);
if (failures.length) console.log(`${failures.length} repo(s) failed; last good data kept where it exists.`);
